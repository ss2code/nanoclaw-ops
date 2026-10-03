#!/usr/bin/env bun
// Deterministic validation for trip-docs, through the REAL pipeline:
//   cli.sock → router → ag-trip-goa container → (agent edits + trip-docs CLI) → groups/trip-goa/<doc>.html
//
// The deterministic side-effect is the canonical HTML file on disk. Beats:
//   1. UPDATE (significant): the doc's version must increment AND no second file
//      may appear (the single-canonical-file invariant — the bug this skill kills).
//   2. MINOR (precision): a typo fix must NOT bump the version and must NOT re-attach
//      the file.
//   3. DELIVER (on-demand): an explicit "send the latest" must attach the file.
// One summary line is appended to results.jsonl per run; score.ts aggregates K runs.
// See docs/local/apps/trip-companion/skill-validation-runbook.html (private overlay).
//
// Usage: bun container/skills/trip-companion-skills/trip-docs/eval/simulate.ts
//   Requires: NanoClaw service running, ag-trip-goa present, data/cli.sock live.

import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readVersion } from '../scripts/docs';

const ROOT = resolve(import.meta.dir, '../../../../..');
const SOCK = join(ROOT, 'data', 'cli.sock');
const CENTRAL = join(ROOT, 'data', 'v2.db');
const DOCS_DIR = join(ROOT, 'groups', 'trip-goa'); // == /workspace/agent inside the container
const CLI = join(import.meta.dir, '..', 'scripts', 'trip-docs.ts');
const AGENT_GROUP = 'ag-trip-goa';
// Override to force a brand-new messaging group → fresh session (no stale transcript
// resume), which matters when validating changed instructions.md/SKILL.md prose.
const PLATFORM = (() => {
  const i = process.argv.indexOf('--run');
  return i >= 0 ? process.argv[i + 1] : (process.env.DOCS_SIM_PLATFORM ?? 'docs-sim');
})();
const OWNER = 'cli:arjun';

const STEP_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;
const QUIESCE_MS = 10_000;
const REPLY_GRACE_MS = 9_000;

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = join(tmpdir(), 'nanoclaw-skill-evals', 'trip-docs');
mkdirSync(LOG_DIR, { recursive: true });
const RUN_LOG = join(LOG_DIR, `run-${TS}.log`);
const RESULTS = join(LOG_DIR, 'results.jsonl');

const NONCE = Math.random().toString(36).slice(2, 8);
const SLUG = `skye-${NONCE}`;
const DOC = `${SLUG}.html`;
const DOC_PATH = join(DOCS_DIR, DOC);

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
    '--name', `Docs sim ${PLATFORM}`, '--is-group', '1', '--unknown-sender-policy', 'strict');
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

function seedDoc(): void {
  const p = Bun.spawnSync(['bun', CLI, '--dir', DOCS_DIR, '--date', '2026-06-14', 'new', SLUG, '--title', `Scotland — Skye option (${NONCE})`], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`seed failed: ${p.stderr.toString()}`);
}

function htmlFiles(): Set<string> {
  return new Set(existsSync(DOCS_DIR) ? readdirSync(DOCS_DIR).filter((f) => f.endsWith('.html')) : []);
}
function docVersion(): number {
  return existsSync(DOC_PATH) ? readVersion(readFileSync(DOC_PATH, 'utf8')) : -1;
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
interface Reply { seq: number; text: string; files: string[] }
function repliesAfter(afterSeq: number): Reply[] {
  const dir = sessionDir();
  if (!dir || !existsSync(join(dir, 'outbound.db'))) return [];
  const db = new Database(join(dir, 'outbound.db'), { readonly: true });
  try {
    return (db.query('SELECT seq, content FROM messages_out WHERE seq > $s ORDER BY seq').all({ $s: afterSeq }) as { seq: number; content: string }[])
      .map((r) => {
        try {
          const c = JSON.parse(r.content);
          return { seq: r.seq, text: typeof c.text === 'string' ? c.text : r.content, files: Array.isArray(c.files) ? c.files : [] };
        } catch { return { seq: r.seq, text: r.content, files: [] }; }
      });
  } catch { return []; }
  finally { db.close(); }
}
const maxSeq = () => { const r = repliesAfter(-1); return r.length ? r[r.length - 1].seq : 0; };

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

interface Summary {
  ts: string;
  bumpOnUpdate: boolean;
  singleFile: boolean;
  noBumpMinor: boolean;
  deliverOnRequest: boolean;
  pdfDelivered: boolean;
  noAttachMinor: boolean;
}

function cleanup(): void {
  for (const f of readdirSync(DOCS_DIR).filter((f) => f.includes(NONCE))) {
    try { unlinkSync(join(DOCS_DIR, f)); } catch { /* ignore */ }
  }
}

async function main(): Promise<void> {
  log(`# trip-docs eval · ${TS}`);
  if (!existsSync(SOCK)) { log(`FATAL: ${SOCK} not found — start the NanoClaw service first.`); process.exit(2); }
  ensureWiring();
  seedDoc();
  log(`wired cli:${PLATFORM} → ${AGENT_GROUP}; seeded ${DOC} at v${docVersion()}`);

  const filesBefore = htmlFiles();
  const seedVersion = docVersion();

  // ── Beat 1: UPDATE (significant) — must bump + must NOT create a second file ──
  let seqBefore = maxSeq();
  const beat1 = `@trip please update the document \`${DOC}\` — we're dropping the Glasgow leg entirely and adding the Isle of Skye option instead. Rework the doc accordingly.`;
  log(`\n── UPDATE (significant) ──\n→ sent: ${beat1}`);
  await send(beat1);
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    if (docVersion() > seedVersion) break;
  }
  await Bun.sleep(REPLY_GRACE_MS);
  const versionAfter1 = docVersion();
  const added = [...htmlFiles()].filter((f) => !filesBefore.has(f));
  const bumpOnUpdate = versionAfter1 > seedVersion;
  const singleFile = added.length === 0;
  log(`← reply: ${repliesAfter(seqBefore).map((r) => r.text).join(' ').slice(0, 220) || '(none)'}`);
  log(`✓ bump:        ${bumpOnUpdate ? `PASS (v${seedVersion}→v${versionAfter1})` : `FAIL (still v${versionAfter1})`}`);
  log(`✓ single-file: ${singleFile ? 'PASS (edited in place)' : `FAIL (new files: ${added.join(', ')})`}`);

  // ── Beat 2: MINOR (precision) — must NOT bump + must NOT re-attach ──
  seqBefore = maxSeq();
  const beat2 = `@trip small thing in \`${DOC}\` — there's a typo, "Edinburg" should be "Edinburgh". Just fix it.`;
  log(`\n── MINOR (precision) ──\n→ sent: ${beat2}`);
  await send(beat2);
  await waitQuiesce(seqBefore);
  const versionAfter2 = docVersion();
  const minorReplies = repliesAfter(seqBefore);
  const noBumpMinor = versionAfter2 === versionAfter1;
  const noAttachMinor = minorReplies.every((r) => r.files.length === 0);
  log(`← reply: ${minorReplies.map((r) => r.text).join(' ').slice(0, 220) || '(none)'}`);
  log(`✓ no-bump:     ${noBumpMinor ? 'PASS' : `FAIL (v${versionAfter1}→v${versionAfter2})`}`);
  log(`✓ no-attach:   ${noAttachMinor ? 'PASS' : 'FAIL (re-sent the file on a minor edit)'}`);

  // ── Beat 3: DELIVER (on-demand) — explicit ask must attach the file ──
  seqBefore = maxSeq();
  const beat3 = `@trip can you send me the latest version of \`${DOC}\`?`;
  log(`\n── DELIVER (on-demand) ──\n→ sent: ${beat3}`);
  await send(beat3);
  await waitQuiesce(seqBefore);
  const deliverReplies = repliesAfter(seqBefore);
  const deliverOnRequest = deliverReplies.some((r) => r.files.length > 0);
  // The delivered artifact must be the rendered PDF, not the .html master.
  const pdfDelivered = deliverReplies.some((r) => r.files.some((f) => f.toLowerCase().endsWith('.pdf')));
  log(`← reply: ${deliverReplies.map((r) => `${r.text}${r.files.length ? ` [files: ${r.files.join(', ')}]` : ''}`).join(' ').slice(0, 240) || '(none)'}`);
  log(`✓ deliver:     ${deliverOnRequest ? 'PASS (file attached)' : 'FAIL (no attachment on explicit request)'}`);
  log(`✓ pdf:         ${pdfDelivered ? 'PASS (rendered PDF attached)' : 'FAIL (delivered something other than a .pdf)'}`);

  const summary: Summary = { ts: TS, bumpOnUpdate, singleFile, noBumpMinor, deliverOnRequest, pdfDelivered, noAttachMinor };
  appendFileSync(RESULTS, JSON.stringify(summary) + '\n');
  writeFileSync(join(LOG_DIR, `summary-${TS}.json`), JSON.stringify(summary, null, 2));
  cleanup();

  log(`\n═══ SUMMARY ═══`);
  log(`update    bump=${bumpOnUpdate ? 'PASS' : 'FAIL'}  single-file=${singleFile ? 'PASS' : 'FAIL'}`);
  log(`minor     no-bump=${noBumpMinor ? 'PASS' : 'FAIL'}  no-attach=${noAttachMinor ? 'PASS' : 'FAIL'}`);
  log(`deliver   on-request=${deliverOnRequest ? 'PASS' : 'FAIL'}  pdf=${pdfDelivered ? 'PASS' : 'FAIL'}`);
  log(`logs: ${RUN_LOG}  ·  longitudinal: ${RESULTS}`);
  process.exit(bumpOnUpdate && singleFile && noBumpMinor && deliverOnRequest ? 0 : 1);
}

main().catch((e) => { log(`ERROR: ${e instanceof Error ? e.message : String(e)}`); cleanup(); process.exit(3); });
