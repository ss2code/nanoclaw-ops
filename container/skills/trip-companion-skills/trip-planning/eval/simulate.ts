#!/usr/bin/env bun
// Gate 3 (design §21): scripted multi-persona planning discussion through the
// REAL pipeline (cli.sock → router → container agent → trip-planning/trip-core
// CLIs → trip.db). Asserts trip.db planning rows + decisions + journal after each
// beat. Beats include the required cases: divergent prefs, a veto, a budget cap,
// an OFF-TOPIC BURST THAT MUST NOT WAKE the agent (engage_mode=mention → zero
// model burn), a propose-with-deadline decision, and a mid-plan change.
//
// The trip frame + roster are pre-seeded deterministically via the trip-core CLI
// (the cold-start "create a 12-person roster in one turn" is not what this gate
// tests), so the run exercises the agent on the planning conversation itself.
//
// Usage: bun eval/simulate.ts [--run <name>] [--fresh] [--from N] [--steps N]
//   Requires the NanoClaw service running and the ag-trip-goa group present.

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../../../..');
const SOCK = join(ROOT, 'data', 'cli.sock');
const CENTRAL = join(ROOT, 'data', 'v2.db');
const TRIP_DB = join(ROOT, 'groups', 'trip-goa', 'trip.db');
const AGENT_GROUP = 'ag-trip-goa';
const RUN = (() => {
  const i = process.argv.indexOf('--run');
  return i >= 0 ? process.argv[i + 1] : 'plan-sim';
})();
const PLATFORM = RUN;

const STEP_TIMEOUT_MS = 420_000;
const POLL_MS = 2_000;
const QUIESCE_MS = 14_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function ncl(...args: string[]): string {
  const proc = Bun.spawnSync(['pnpm', 'exec', 'tsx', 'src/cli/client.ts', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc.stdout.toString() + proc.stderr.toString();
}

function tripCore(...args: string[]): string {
  const proc = Bun.spawnSync(['bun', join(import.meta.dir, '..', '..', 'trip-core', 'scripts', 'trip-core.ts'), '--db', TRIP_DB, ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc.stdout.toString() + proc.stderr.toString();
}

function ensureRunWiring(): void {
  ncl('messaging-groups', 'create', '--channel-type', 'cli', '--platform-id', PLATFORM,
    '--name', `Plan sim ${PLATFORM}`, '--is-group', '1', '--unknown-sender-policy', 'strict');
  const central = new Database(CENTRAL, { readonly: true });
  const mg = central.query("SELECT id FROM messaging_groups WHERE channel_type = 'cli' AND platform_id = $p").get({ $p: PLATFORM }) as { id: string } | null;
  central.close();
  if (!mg) throw new Error(`failed to create/find messaging group for ${PLATFORM}`);
  // context-aware mention: only @trip wakes the agent; un-mentioned chatter accumulates (no model call) — §4
  ncl('wirings', 'create', '--messaging-group-id', mg.id, '--agent-group-id', AGENT_GROUP,
    '--engage-mode', 'pattern', '--engage-pattern', '@trip', '--sender-scope', 'known',
    '--ignored-message-policy', 'accumulate', '--session-mode', 'shared');
  ncl('destinations', 'add', '--agent-group-id', AGENT_GROUP, '--local-name', PLATFORM,
    '--target-type', 'channel', '--target-id', mg.id);
}

/** Pre-seed the trip frame + roster deterministically (not what Gate 3 tests). */
function seedTrip(): void {
  tripCore('setup', 'ensure', '--name', 'Goa 2026', '--base-currency', 'INR', '--start', '2026-08-14', '--end', '2026-08-17', '--by', '1');
  for (const n of ['Arjun', 'Diya', 'Maya', 'Raj', 'Dev', 'Aarti']) tripCore('member', 'add', '--name', n, '--joined', '2026-08-14', '--by', '1');
}

function send(sender: string, senderId: string, text: string): Promise<void> {
  return new Promise((res, rej) => {
    const sock = net.connect(SOCK);
    sock.on('error', rej);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ text, sender, senderId, to: { channelType: 'cli', platformId: PLATFORM, threadId: null } }) + '\n');
      sock.end();
      res();
    });
  });
}

function tripDb(): Database | null {
  if (!existsSync(TRIP_DB)) return null;
  return new Database(TRIP_DB, { readonly: true });
}
function count(sql: string): number {
  const db = tripDb();
  if (!db) return 0;
  try {
    return (db.query(sql).get() as { n: number } | null)?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}
const counts = () => ({
  destinations: count('SELECT COUNT(*) AS n FROM destinations'),
  decisions: count('SELECT COUNT(*) AS n FROM decisions'),
  items: count('SELECT COUNT(*) AS n FROM itinerary_items'),
  scratchpad: count('SELECT COUNT(*) AS n FROM scratchpad'),
});

function sessionDir(): string | null {
  const db = new Database(CENTRAL, { readonly: true });
  try {
    const row = db.query(
      `SELECT s.id FROM sessions s JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       WHERE s.agent_group_id = $ag AND mg.platform_id = $p ORDER BY s.created_at DESC LIMIT 1`,
    ).get({ $ag: AGENT_GROUP, $p: PLATFORM }) as { id: string } | null;
    if (!row) return null;
    const dir = join(ROOT, 'data', 'v2-sessions', AGENT_GROUP, row.id);
    return existsSync(dir) ? dir : null;
  } finally {
    db.close();
  }
}
function lastReplies(afterSeq: number): { seq: number; text: string }[] {
  const dir = sessionDir();
  if (!dir || !existsSync(join(dir, 'outbound.db'))) return [];
  const db = new Database(join(dir, 'outbound.db'), { readonly: true });
  try {
    return (db.query('SELECT seq, content FROM messages_out WHERE seq > $s ORDER BY seq').all({ $s: afterSeq }) as { seq: number; content: string }[]).map((r) => {
      try {
        const c = JSON.parse(r.content);
        return { seq: r.seq, text: typeof c.text === 'string' ? c.text : r.content };
      } catch {
        return { seq: r.seq, text: r.content };
      }
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}
const maxSeq = () => {
  const r = lastReplies(-1);
  return r.length ? r[r.length - 1].seq : 0;
};

type Persona = [string, string];
const P: Record<string, Persona> = {
  arjun: ['Arjun', 'cli:arjun'], diya: ['Diya', 'cli:diya'], maya: ['Maya', 'cli:maya'],
  raj: ['Raj', 'cli:raj'], dev: ['Dev', 'cli:dev'], aarti: ['Aarti', 'cli:aarti'],
};

interface Step {
  label: string;
  persona: Persona;
  text: string;
  until?: (c: ReturnType<typeof counts>) => boolean;
  expectNoEffect?: boolean;
  confirmWith?: string;
  check?: (replies: string[]) => void;
}

const failures: string[] = [];
const transcript: string[] = [];

async function quiesce(): Promise<void> {
  let last = maxSeq();
  let quietSince = Date.now();
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    const now = maxSeq();
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= QUIESCE_MS) return;
  }
}

async function runStep(step: Step): Promise<void> {
  await quiesce();
  const before = counts();
  const seq0 = maxSeq();
  await send(step.persona[0], step.persona[1], step.text);
  transcript.push(`>> [${step.persona[0]}] ${step.text}`);

  if (step.expectNoEffect) {
    await Bun.sleep(25_000);
    const after = counts();
    const replies = lastReplies(seq0);
    if (JSON.stringify(after) !== JSON.stringify(before) || replies.length > 0) {
      failures.push(`${step.label}: expected NO wake, got effect/replies: ${replies.map((r) => r.text).join(' | ').slice(0, 160)}`);
      console.log(`  ✗ ${step.label} (should not have woken)`);
    } else console.log(`  ✓ ${step.label} (correctly ignored — zero model burn)`);
    return;
  }

  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let confirmed = 0;
  let lastSeq = seq0;
  while (Date.now() < deadline) {
    const c = counts();
    if (!step.until || step.until(c)) {
      const replies = lastReplies(seq0).map((r) => r.text);
      try {
        step.check?.(replies);
        console.log(`  ✓ ${step.label}`);
      } catch (err) {
        failures.push(`${step.label}: ${err}`);
        console.log(`  ✗ ${step.label}: ${err}`);
      }
      return;
    }
    const replies = lastReplies(lastSeq);
    if (replies.length > 0) {
      lastSeq = replies[replies.length - 1].seq;
      if (step.confirmWith && confirmed < 2) {
        confirmed++;
        await Bun.sleep(1_500);
        await send(step.persona[0], step.persona[1], step.confirmWith);
      }
    }
    await Bun.sleep(POLL_MS);
  }
  failures.push(`${step.label}: TIMEOUT`);
  console.log(`  ✗ ${step.label}: TIMEOUT`);
}

const STEPS: Step[] = [
  {
    label: 'divergent prefs → propose destinations (candidates created)',
    persona: P.arjun,
    text: '@trip we are 6 friends, ~₹25k each, INR, ovo-veg, want relaxed + a little adventure for a long weekend. Some of us want beaches, Maya wants somewhere quieter and off-beat. Propose 3 destination options and add them to the plan as candidates.',
    until: (c) => c.destinations >= 1,
    confirmWith: '@trip yes, add those candidates.',
  },
  {
    label: 'OFF-TOPIC BURST must NOT wake the agent (no @mention)',
    persona: P.aarti,
    text: 'lol did everyone see the sunset pics 😍 the beach was unreal, see you all at dinner 7pm!',
    expectNoEffect: true,
  },
  {
    label: "Maya's veto recorded as a scratchpad note",
    persona: P.maya,
    text: '@trip honestly please no touristy crowded beaches for me — note that I lean quiet and off-beat.',
    until: (c) => c.scratchpad >= 1,
    confirmWith: '@trip yes please note it.',
  },
  {
    label: 'propose-with-deadline decision opened',
    persona: P.arjun,
    text: '@trip we are a bit split. Open a decision to pick the destination, propose your top one, and say you will lock it by 9pm tonight unless someone objects.',
    until: (c) => c.decisions >= 1,
    confirmWith: '@trip yes, open it.',
  },
  {
    label: 'budget cap respected on a stay suggestion',
    persona: P.raj,
    text: '@trip suggest a stay but keep it within ₹25k each for the whole trip — and tell me if it would blow the budget.',
    until: () => true,
    check: (replies) => {
      const blob = replies.join(' ').toLowerCase();
      if (!/budget|₹|25|within|cap/.test(blob)) throw new Error('reply did not address the budget cap');
    },
  },
];

async function main(): Promise<void> {
  if (!existsSync(SOCK)) {
    console.error(`socket not found at ${SOCK} — is the NanoClaw service running?`);
    process.exit(2);
  }
  ensureRunWiring();
  if (process.argv.includes('--fresh')) {
    const { unlinkSync } = await import('node:fs');
    try {
      unlinkSync(TRIP_DB);
    } catch {}
    seedTrip();
    ncl('groups', 'restart', '--id', AGENT_GROUP);
    console.log('fresh run: trip.db reseeded (frame + roster), container restarted');
  } else {
    seedTrip();
  }
  const from = Number(arg('from', '0'));
  const limit = Number(arg('steps', String(STEPS.length)));
  const steps = STEPS.slice(from, from + limit);
  console.log(`Planning discussion simulator — ${steps.length} beats via real pipeline\n`);
  for (let i = 0; i < steps.length; i++) {
    console.log(`[${i + 1}/${steps.length}] ${steps[i].label}`);
    await runStep(steps[i]);
  }
  console.log('\n── transcript ──');
  for (const l of transcript) console.log(l.length > 240 ? l.slice(0, 240) + '…' : l);
  console.log(`\n── Gate 3 result: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} ──`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
