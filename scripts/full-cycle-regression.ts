#!/usr/bin/env node
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ensureWebChat, getWebChatState, sendViaCliSock } from '../ops-center/chat.js';
import { PATHS } from '../ops-center/config.js';
import { openOpsDb } from '../ops-center/opsdb.js';
import { RuntimePowerController, type RuntimePowerSnapshot } from '../ops-center/runtime-power.js';
import { runFullLifecycleCycle, type LifecycleCycleDriver, type LifecyclePhase } from './full-cycle-regression-lib.js';

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_MS = 1_000;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function resolveGroup(selector: string): { id: string; name: string } {
  const db = new Database(PATHS.centralDb, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT id, name FROM agent_groups WHERE id = ? OR lower(name) = lower(?) ORDER BY id = ? DESC LIMIT 1')
      .get(selector, selector, selector) as { id: string; name: string } | undefined;
    if (!row) throw new Error(`No agent group matches ${JSON.stringify(selector)}`);
    return row;
  } finally {
    db.close();
  }
}

async function waitForSnapshot(
  power: RuntimePowerController,
  timeoutMs: number,
  label: string,
  predicate: (snapshot: RuntimePowerSnapshot) => boolean,
): Promise<RuntimePowerSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let latest = await power.snapshot();
  while (!predicate(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    latest = await power.snapshot();
  }
  if (!predicate(latest)) {
    throw new Error(
      `${label} timed out: desired=${latest.desiredState}, host=${latest.host.running}, ` +
        `docker=${latest.docker.daemonUp}, onecli=${latest.onecli.up}, ops=${latest.opsCenter.running}`,
    );
  }
  return latest;
}

function maxOutboundSeq(sessionDir: string): number {
  const file = path.join(sessionDir, 'outbound.db');
  if (!fs.existsSync(file)) return 0;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT MAX(seq) AS seq FROM messages_out').get() as { seq: number | null };
    return row.seq ?? 0;
  } finally {
    db.close();
  }
}

function repliesAfter(sessionDir: string, cursor: number): string[] {
  const file = path.join(sessionDir, 'outbound.db');
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare("SELECT content FROM messages_out WHERE kind = 'chat' AND seq > ? ORDER BY seq")
      .all(cursor) as { content: string }[];
    return rows.map((row) => {
      try {
        const content = JSON.parse(row.content) as { text?: unknown };
        return typeof content.text === 'string' ? content.text : row.content;
      } catch {
        return row.content;
      }
    });
  } finally {
    db.close();
  }
}

async function probeAgent(
  group: { id: string; name: string },
  phase: LifecyclePhase,
  timeoutMs: number,
): Promise<void> {
  const wired = await ensureWebChat(group.id, group.name);
  if (!wired.ok) throw new Error(`Web-chat setup failed: ${wired.message}`);

  let state = getWebChatState(group.id);
  const initialDir = state.sessionDir;
  const cursor = initialDir ? maxOutboundSeq(initialDir) : 0;
  const token = `LIFECYCLE-CANARY-${phase.toUpperCase()}-${Date.now()}`;
  const sent = await sendViaCliSock(
    group.id,
    `Lifecycle regression health check. Reply with exactly this token and nothing else: ${token}`,
  );
  if (!sent.ok) throw new Error(`Agent probe send failed: ${sent.message}`);

  const deadline = Date.now() + timeoutMs;
  let latestReply = '';
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    state = getWebChatState(group.id);
    if (!state.sessionDir) continue;
    for (const reply of repliesAfter(state.sessionDir, state.sessionDir === initialDir ? cursor : 0)) {
      latestReply = reply;
      if (reply.includes(token)) return;
    }
  }
  const detail = latestReply ? `; latest reply was ${JSON.stringify(latestReply.slice(0, 160))}` : '';
  throw new Error(`Agent ${group.name} did not return canary ${token} within ${timeoutMs}ms${detail}`);
}

async function main(): Promise<void> {
  if (!has('yes')) {
    console.error('This regression intentionally hard-stops NanoClaw, Ops Center, OneCLI, and Docker Desktop twice.');
    console.error('Re-run with --yes after saving unrelated Docker work.');
    process.exit(2);
  }

  const timeoutMs = Number(arg('timeout') ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) throw new Error('--timeout must be at least 10000ms');
  const group = resolveGroup(arg('group') ?? 'Jeeves');
  const opsDb = openOpsDb(PATHS.opsDb);
  const power = new RuntimePowerController(opsDb, undefined, { timeoutMs, pollMs: POLL_MS });

  const assertReady = async (): Promise<void> => {
    await waitForSnapshot(
      power,
      timeoutMs,
      'runtime readiness',
      (snapshot) =>
        snapshot.runtimeRunning &&
        snapshot.opsCenter.running &&
        fs.existsSync(path.join(path.dirname(PATHS.centralDb), 'cli.sock')),
    );
  };
  const driver: LifecycleCycleDriver = {
    preflight: async () => {
      const started = await power.startRuntime({ includeOpsCenter: true });
      if (!started.ok) throw new Error(started.message);
      await assertReady();
      const wired = await ensureWebChat(group.id, group.name);
      if (!wired.ok) throw new Error(`Web-chat preflight failed: ${wired.message}`);
    },
    hardOff: async () => {
      const stopped = await power.prepareHardOff();
      if (!stopped.ok) throw new Error(stopped.message);
      await power.stopOpsCenter();
    },
    assertStopped: async () => {
      await waitForSnapshot(
        power,
        timeoutMs,
        'hard-off state',
        (snapshot) =>
          snapshot.runtimeStopped &&
          !snapshot.opsCenter.running &&
          (!snapshot.onecli.local || !snapshot.onecli.up) &&
          snapshot.wakeCyclerPaused,
      );
    },
    start: async () => {
      const started = await power.startRuntime({ includeOpsCenter: true });
      if (!started.ok) throw new Error(started.message);
    },
    assertReady: async () => assertReady(),
    probeAgent: async (phase) => probeAgent(group, phase, timeoutMs),
  };

  console.log(`NanoClaw full lifecycle regression · ${group.name} (${group.id})`);
  const report = await runFullLifecycleCycle(driver, (message) => console.log(message));
  opsDb.close();

  console.log('');
  console.log(report.ok ? 'FULL LIFECYCLE PASS' : 'FULL LIFECYCLE FAIL');
  if (!report.ok) console.log(report.recovered ? 'Runtime recovered to running state.' : 'Automatic recovery failed.');
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
