/**
 * Self-tests trigger for the Ops Center.
 *
 * Fires the fork's live validation suites (scripts/self-tests-suite/) against
 * one agent group or all of them, from the System page. Runs are sequential
 * (each probe consumes real model turns; parallel runs would also race the
 * shared web-chat sessions), tagged with a run id, and fully journaled to
 * logs/self-tests/<runId>/ so an LLM can triage a failure from the artifacts
 * alone. Verdicts are delivered to the alert Telegram chat.
 *
 * Artifacts per run:
 *   logs/self-tests/<runId>/manifest.json          groups, timing, verdicts
 *   logs/self-tests/<runId>/<group>.report.json    suite report (per-case expected/actual)
 *   logs/self-tests/<runId>/<group>.log            live probe log (stderr of the run)
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadConfig, ROOT } from './config.js';
import { sendTelegram } from './alerter.js';
import { withCentral } from './readers/central.js';

const SUITE = 'model-routing';
const RUNS_DIR = path.join(ROOT, 'logs', 'self-tests');
const PER_GROUP_TIMEOUT_MS = 20 * 60_000; // hard kill for one group's run

export interface SelfTestGroup {
  id: string;
  name: string;
  provider: string;
}

export interface SelfTestState {
  running: boolean;
  runId: string | null;
  suite: string;
  queue: string[]; // group ids not yet started
  current: string | null; // group id in flight
  done: { group: string; verdict: string }[];
  startedAt: string | null;
  lastRunId: string | null;
  lastSummary: string | null;
}

const state: SelfTestState = {
  running: false,
  runId: null,
  suite: SUITE,
  queue: [],
  current: null,
  done: [],
  startedAt: null,
  lastRunId: null,
  lastSummary: null,
};

export function selfTestState(): SelfTestState {
  return { ...state, queue: [...state.queue], done: [...state.done] };
}

/** Groups offered in the System-page picker (any group can be targeted). */
export function listSelfTestGroups(): SelfTestGroup[] {
  return withCentral((db) =>
    (
      db
        .prepare(
          `SELECT ag.id, ag.name, COALESCE(cc.provider, 'claude') AS provider
           FROM agent_groups ag LEFT JOIN container_configs cc ON cc.agent_group_id = ag.id
           ORDER BY ag.name`,
        )
        .all() as { id: string; name: string; provider: string }[]
    ).map((r) => ({ id: r.id, name: r.name, provider: r.provider })),
  );
}

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `st-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SuiteCase {
  name: string;
  pass: boolean;
  detail: string;
}
interface SuiteReport {
  passed: number;
  failed: number;
  cases: SuiteCase[];
}

/** Run one group's suite as a child process; returns verdict + per-case results. */
function runGroup(runId: string, group: SelfTestGroup): Promise<{ verdict: string; cases: SuiteCase[] }> {
  return new Promise((resolve) => {
    const dir = path.join(RUNS_DIR, runId);
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, `${group.id}.log`);
    const reportPath = path.join(dir, `${group.id}.report.json`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(ROOT, 'scripts', 'self-tests-suite', 'run.ts'),
        SUITE,
        '--group',
        group.id,
        '--json',
        '--timeout',
        '90000',
      ],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.pipe(logStream);

    const killer = setTimeout(() => {
      logStream.write(`\n[selftest] hard timeout after ${PER_GROUP_TIMEOUT_MS}ms — killing run\n`);
      child.kill('SIGKILL');
    }, PER_GROUP_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(killer);
      logStream.end();
      let report: SuiteReport | null = null;
      try {
        report = JSON.parse(stdout) as SuiteReport;
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      } catch {
        fs.writeFileSync(reportPath, JSON.stringify({ error: 'unparseable suite output', exitCode: code, raw: stdout.slice(0, 4000) }, null, 2));
      }
      if (report && typeof report.passed === 'number') {
        const total = report.passed + report.failed;
        resolve({
          verdict: report.failed === 0 ? `✅ ${report.passed}/${total}` : `❌ ${report.failed} failed /${total}`,
          cases: report.cases ?? [],
        });
      } else {
        resolve({ verdict: `⚠️ suite error (exit ${code})`, cases: [] });
      }
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      logStream.end();
      fs.writeFileSync(reportPath, JSON.stringify({ error: String(err) }, null, 2));
      resolve({ verdict: `⚠️ spawn error: ${err.message}`, cases: [] });
    });
  });
}

async function notify(runId: string, text: string): Promise<void> {
  // Journal the exact message alongside the run artifacts — verifiable even
  // if Telegram delivery fails, and part of the triage bundle.
  try {
    fs.appendFileSync(path.join(RUNS_DIR, runId, 'notifications.log'), `${new Date().toISOString()}\n${text}\n\n`);
  } catch {
    /* ignore */
  }
  try {
    await sendTelegram(loadConfig(), text);
  } catch {
    /* alerting is best-effort; artifacts on disk are the source of truth */
  }
}

/**
 * Start a run against one group id or 'all'. Returns immediately with the run
 * id; per-group verdicts stream to Telegram as they finish.
 */
export function startSelfTest(target: string): { ok: boolean; message: string; runId?: string } {
  if (state.running) {
    return { ok: false, message: `A self-test run is already in flight (${state.runId}, on ${state.current ?? 'queue'})` };
  }
  const all = listSelfTestGroups();
  const groups = target === 'all' ? all : all.filter((g) => g.id === target);
  if (groups.length === 0) return { ok: false, message: `Unknown agent group: ${target}` };

  const runId = newRunId();
  state.running = true;
  state.runId = runId;
  state.queue = groups.map((g) => g.id);
  state.current = null;
  state.done = [];
  state.startedAt = new Date().toISOString();

  const dir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });

  void (async () => {
    const startedMs = Date.now();
    const results: { group: SelfTestGroup; verdict: string }[] = [];
    for (const group of groups) {
      state.queue = state.queue.filter((id) => id !== group.id);
      state.current = group.id;
      const t0 = Date.now();
      const { verdict, cases } = await runGroup(runId, group);
      const mins = ((Date.now() - t0) / 60_000).toFixed(1);
      state.done.push({ group: group.id, verdict });
      results.push({ group, verdict });

      // Full per-case results in the message — readers on a phone have no
      // access to the artifact files, so the verdict must stand alone.
      const caseLines = cases.map((c) => `${c.pass ? '✅' : '❌'} ${c.name} — ${c.detail}`).join('\n');
      await notify(
        runId,
        [
          `🧪 self-test ${SUITE} · ${group.name} — ${verdict} (${mins}m)`,
          caseLines,
          `run ${runId}`,
          `logs: logs/self-tests/${runId}/${group.id}.{report.json,log}`,
          verdict.startsWith('✅') ? '' : `triage: hand the run id + those paths to Claude Code`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    const summary = results.map((r) => `${r.group.name} ${r.verdict}`).join(' · ');
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(
        {
          runId,
          suite: SUITE,
          startedAt: state.startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
          groups: results.map((r) => ({ id: r.group.id, name: r.group.name, provider: r.group.provider, verdict: r.verdict })),
        },
        null,
        2,
      ),
    );
    if (groups.length > 1) {
      await notify(runId, `🧪 self-test ${SUITE} run ${runId} complete: ${summary}`);
    }
    state.running = false;
    state.current = null;
    state.lastRunId = runId;
    state.lastSummary = summary;
  })();

  return { ok: true, message: `Self-test ${runId} started (${groups.length} group(s)); verdicts go to Telegram`, runId };
}
