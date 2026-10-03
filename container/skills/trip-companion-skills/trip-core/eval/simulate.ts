#!/usr/bin/env bun
// Deterministic validation for trip-core's GROUNDED WORKING STATE, through the
// REAL pipeline:
//   cli.sock → router → ag-trip-goa container → trip-core CLI → trip.db
//
// trip-core's job is to turn language into deterministic state mutations and let
// the script own the store. Two ungated/low-stakes side-effects are the spine:
//   • a SCRATCHPAD note  — "jot this down" → scratchpad row (tier 1, ungated §13)
//   • a DECISION         — "put it to a vote" → decisions row (consensus §14)
// We also run a NEGATIVE precision beat: pure chatter must mutate NOTHING.
//
// Each beat asserts the deterministic side-effect (a trip.db row) and OBSERVES
// the agent's reply for an acknowledgement keyword. One summary line is appended
// to results.jsonl per run; a score.ts could aggregate K runs (mirrors
// trip-docs). See docs/local/apps/trip-companion/skill-validation-runbook.html (private overlay).
//
// Usage: bun container/skills/trip-companion-skills/trip-core/eval/simulate.ts
//   Requires: NanoClaw service running, ag-trip-goa present, data/cli.sock live.

import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../../../..');
const SOCK = join(ROOT, 'data', 'cli.sock');
const CENTRAL = join(ROOT, 'data', 'v2.db');
const TRIP_DB = join(ROOT, 'groups', 'trip-goa', 'trip.db');
const AGENT_GROUP = 'ag-trip-goa';
const PLATFORM = (() => {
  const i = process.argv.indexOf('--run');
  return i >= 0 ? process.argv[i + 1] : 'core-sim';
})();
const OWNER = 'cli:arjun';

const STEP_TIMEOUT_MS = 240_000; // haiku in a cold container can take a while
const POLL_MS = 2_000;
const QUIESCE_MS = 10_000;
const REPLY_GRACE_MS = 9_000; // after a DB write, wait for the (lagging) confirmation reply

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = join(tmpdir(), 'nanoclaw-skill-evals', 'trip-core');
mkdirSync(LOG_DIR, { recursive: true });
const RUN_LOG = join(LOG_DIR, `run-${TS}.log`);
const RESULTS = join(LOG_DIR, 'results.jsonl');

function log(line = ''): void {
  appendFileSync(RUN_LOG, line + '\n');
  console.log(line);
}

function ncl(...args: string[]): string {
  const p = Bun.spawnSync(['pnpm', 'exec', 'tsx', 'src/cli/client.ts', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  return p.stdout.toString() + p.stderr.toString();
}

function ensureWiring(): void {
  ncl('messaging-groups', 'create', '--channel-type', 'cli', '--platform-id', PLATFORM,
    '--name', `Core sim ${PLATFORM}`, '--is-group', '1', '--unknown-sender-policy', 'strict');
  const central = new Database(CENTRAL, { readonly: true });
  const mg = central.query("SELECT id FROM messaging_groups WHERE channel_type='cli' AND platform_id=$p").get({ $p: PLATFORM }) as { id: string } | null;
  central.close();
  if (!mg) throw new Error(`no messaging group for ${PLATFORM} — is the service running?`);
  ncl('wirings', 'create', '--messaging-group-id', mg.id, '--agent-group-id', AGENT_GROUP,
    '--engage-mode', 'pattern', '--engage-pattern', '@trip', '--sender-scope', 'known',
    '--ignored-message-policy', 'accumulate', '--session-mode', 'shared');
  ncl('destinations', 'add', '--agent-group-id', AGENT_GROUP, '--local-name', PLATFORM, '--target-type', 'channel', '--target-id', mg.id);
  ncl('users', 'create', '--id', OWNER, '--display-name', 'Arjun');
}

function send(text: string): Promise<void> {
  return new Promise((res, rej) => {
    const sock = net.connect(SOCK);
    sock.on('error', rej);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ text, sender: 'Arjun', senderId: OWNER, to: { channelType: 'cli', platformId: PLATFORM, threadId: null } }) + '\n');
      sock.end();
      res();
    });
  });
}

// ── trip.db side-effect readers (read-only; journal_mode=DELETE makes this safe) ──

interface ScratchRow { id: number; topic: string | null; note: string; status: string }
function scratchRows(): ScratchRow[] {
  if (!existsSync(TRIP_DB)) return [];
  const db = new Database(TRIP_DB, { readonly: true });
  try { return db.query('SELECT id, topic, note, status FROM scratchpad ORDER BY id').all() as ScratchRow[]; }
  catch { return []; }
  finally { db.close(); }
}

interface DecisionRow { id: number; question: string; mode: string; options_json: string | null; status: string }
function decisionRows(): DecisionRow[] {
  if (!existsSync(TRIP_DB)) return [];
  const db = new Database(TRIP_DB, { readonly: true });
  try { return db.query('SELECT id, question, mode, options_json, status FROM decisions ORDER BY id').all() as DecisionRow[]; }
  catch { return []; }
  finally { db.close(); }
}

// ── outbound.db reply peeking ──

function sessionDir(): string | null {
  const db = new Database(CENTRAL, { readonly: true });
  try {
    const row = db.query(
      `SELECT s.id FROM sessions s JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       WHERE s.agent_group_id=$ag AND mg.platform_id=$p ORDER BY s.created_at DESC LIMIT 1`,
    ).get({ $ag: AGENT_GROUP, $p: PLATFORM }) as { id: string } | null;
    if (!row) return null;
    const dir = join(ROOT, 'data', 'v2-sessions', AGENT_GROUP, row.id);
    return existsSync(dir) ? dir : null;
  } finally { db.close(); }
}
function repliesAfter(afterSeq: number): { seq: number; text: string }[] {
  const dir = sessionDir();
  if (!dir || !existsSync(join(dir, 'outbound.db'))) return [];
  const db = new Database(join(dir, 'outbound.db'), { readonly: true });
  try {
    return (db.query('SELECT seq, content FROM messages_out WHERE seq > $s ORDER BY seq').all({ $s: afterSeq }) as { seq: number; content: string }[])
      .map((r) => { try { const c = JSON.parse(r.content); return { seq: r.seq, text: typeof c.text === 'string' ? c.text : r.content }; } catch { return { seq: r.seq, text: r.content }; } });
  } catch { return []; }
  finally { db.close(); }
}
const maxSeq = () => { const r = repliesAfter(-1); return r.length ? r[r.length - 1].seq : 0; };

// ── beats ──

interface Beat { id: string; kind: 'note' | 'decision' | 'negative'; text: string; expect?: RegExp; ack?: RegExp; confirm?: string }

// A UNIQUE place-nonce per run keeps each beat's row genuinely new and lets the
// harness match THIS run's row (the agent preserves the coined proper noun
// verbatim in the note body / decision question). New-row detection (beforeIds)
// is the primary signal; the nonce match confirms it captured the right thing.
const NONCE = Math.random().toString(36).slice(2, 8);
const PLACE = `Zalvora${NONCE}`;
const BEATS: Beat[] = [
  // must-fire, ungated (§13): a leaning + a thing to research → a scratchpad note, instantly.
  { id: 'note', kind: 'note',
    text: `@trip jot this down — the group is leaning toward basing ourselves near ${PLACE} for the quieter vibe, and we still need to research ferry timings to ${PLACE}.`,
    expect: new RegExp(NONCE), ack: /note|jot|noted|scratch|added|recorded/i },
  // consensus (§14): an explicit request to put a choice to the group → a decision row.
  { id: 'decision', kind: 'decision',
    text: `@trip let's put it to a vote — should we be based near ${PLACE} or stay by the main beach? Open a quick poll for the group.`,
    expect: new RegExp(NONCE), ack: /poll|vote|decision|proposal|open/i, confirm: '@trip yes, go ahead and open the poll.' },
  // precision: a plain thank-you must mutate NOTHING (no note, no decision).
  { id: 'precision', kind: 'negative',
    text: '@trip thanks, this has been really helpful — can\'t wait for the trip!' },
];

interface BeatResult { id: string; kind: string; pass: boolean; ack: boolean; detail: string }

async function waitQuiesce(seqBefore: number): Promise<void> {
  let last = maxSeq(); let quietSince = Date.now();
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    const now = maxSeq();
    if (now !== last) { last = now; quietSince = Date.now(); }
    else if (now > seqBefore && Date.now() - quietSince > QUIESCE_MS) return;
  }
}

function freshNote(before: Set<number>, expect: RegExp): ScratchRow | undefined {
  return scratchRows().find((r) => !before.has(r.id) && expect.test(`${r.topic ?? ''} ${r.note}`));
}
function freshDecision(before: Set<number>, expect: RegExp): DecisionRow | undefined {
  return decisionRows().find((r) => !before.has(r.id) && expect.test(`${r.question} ${r.options_json ?? ''}`));
}

async function runBeat(b: Beat): Promise<BeatResult> {
  const scratchBefore = new Set(scratchRows().map((r) => r.id));
  const decisionBefore = new Set(decisionRows().map((r) => r.id));
  const seqBefore = maxSeq();
  log(`\n── ${b.kind.toUpperCase()} (${b.id}) ──\n→ sent: ${b.text}`);
  await send(b.text);

  if (b.kind === 'negative') {
    await waitQuiesce(seqBefore);
    const leakNotes = scratchRows().filter((r) => !scratchBefore.has(r.id));
    const leakDecisions = decisionRows().filter((r) => !decisionBefore.has(r.id));
    const pass = leakNotes.length === 0 && leakDecisions.length === 0; // precision: NOTHING should be written
    log(`← reply: ${repliesAfter(seqBefore).map((r) => r.text).join(' ').slice(0, 200) || '(none)'}`);
    log(`✓ precision (no spurious write): ${pass ? 'PASS' : `FAIL (+${leakNotes.length} note, +${leakDecisions.length} decision)`}`);
    return { id: b.id, kind: b.kind, pass, ack: false, detail: pass ? 'no write' : `leaked ${leakNotes.length}n/${leakDecisions.length}d` };
  }

  // positive beats: poll for the matching row; if a reply lands first (a
  // confirm-before-commit playback), answer `confirm` once so the row still lands.
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let confirmed = 0;
  let lastSeq = seqBefore;
  let hit: { id: number; label: string } | null = null;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    if (b.kind === 'note') {
      const r = freshNote(scratchBefore, b.expect!);
      if (r) { hit = { id: r.id, label: r.note.slice(0, 60) }; break; }
    } else {
      const r = freshDecision(decisionBefore, b.expect!);
      if (r) { hit = { id: r.id, label: `${r.mode}: ${r.question.slice(0, 50)}` }; break; }
    }
    const replies = repliesAfter(lastSeq);
    if (replies.length > 0) {
      lastSeq = replies[replies.length - 1].seq;
      if (b.confirm && confirmed < 2) { confirmed++; await send(b.confirm); log(`  ↳ confirm: ${b.confirm}`); }
    }
  }
  if (hit) await Bun.sleep(REPLY_GRACE_MS);
  const replies = repliesAfter(seqBefore).map((r) => r.text).join('\n');
  const ack = b.ack ? b.ack.test(replies) : false;
  log(`← reply: ${replies.slice(0, 220) || '(none)'}`);
  log(`✓ ${b.id === 'note' ? 'note written' : 'decision opened'}: ${hit ? `PASS (#${hit.id} ${hit.label})` : 'FAIL'}   ack: ${ack ? 'PASS' : 'FAIL'}`);
  return { id: b.id, kind: b.kind, pass: !!hit, ack, detail: hit ? `#${hit.id}` : 'no row' };
}

async function main(): Promise<void> {
  log(`# trip-core working-state eval · ${TS}`);
  if (!existsSync(SOCK)) { log(`FATAL: ${SOCK} not found — start the NanoClaw service first.`); process.exit(2); }
  ensureWiring();
  log(`wired cli:${PLATFORM} → ${AGENT_GROUP}; owner=${OWNER}; unique place=${PLACE}`);

  const results: BeatResult[] = [];
  for (const b of BEATS) results.push(await runBeat(b));
  const by = (id: string) => results.find((r) => r.id === id);

  const summary = {
    ts: TS,
    note: by('note')?.pass ?? false,
    decision: by('decision')?.pass ?? false,
    precision: by('precision')?.pass ?? false,
    ackNote: by('note')?.ack ?? false,
    ackDecision: by('decision')?.ack ?? false,
  };
  appendFileSync(RESULTS, JSON.stringify(summary) + '\n');
  writeFileSync(join(LOG_DIR, `summary-${TS}.json`), JSON.stringify({ summary, results }, null, 2));

  log(`\n═══ SUMMARY ═══`);
  log(`note      scratchpad=${summary.note ? 'PASS' : 'FAIL'}`);
  log(`decision  consensus=${summary.decision ? 'PASS' : 'FAIL'}`);
  log(`precision negative=${summary.precision ? 'PASS' : 'FAIL'}`);
  log(`ack       note=${summary.ackNote ? 'PASS' : 'FAIL'}  decision=${summary.ackDecision ? 'PASS' : 'FAIL'}  (agent-relayed; observed, not gated)`);
  log(`logs: ${RUN_LOG}  ·  longitudinal: ${RESULTS}`);
  process.exit(summary.note && summary.decision && summary.precision ? 0 : 1);
}

main().catch((e) => { log(`ERROR: ${e instanceof Error ? e.message : String(e)}`); process.exit(3); });
