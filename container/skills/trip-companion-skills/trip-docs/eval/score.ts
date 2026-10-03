#!/usr/bin/env bun
// Reliability SCORE for the trip-docs skill. A single harness run is an anecdote
// (the agent is stochastic), so this runs simulate.ts K times and aggregates each
// dimension's pass-rate with mean ± stddev, then weights them into a 0-100 score
// against ship gates. Methodology adopted from /skill-creator (variance-aware
// benchmarking); the runner is our cli.sock harness (the real NanoClaw pipeline).
// See docs/local/apps/trip-companion/skill-validation-runbook.html (private overlay).
//
// Usage: bun container/skills/trip-companion-skills/trip-docs/eval/score.ts [--runs K]   (default K=3)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../../../..');
const SIM = join(import.meta.dir, 'simulate.ts');
const LOG_DIR = join(tmpdir(), 'nanoclaw-skill-evals', 'trip-docs');
const RESULTS = join(LOG_DIR, 'results.jsonl');

const K = (() => { const i = process.argv.indexOf('--runs'); return i >= 0 ? Math.max(1, Number(process.argv[i + 1])) : 3; })();
const RUN = (() => {
  const i = process.argv.indexOf('--run');
  return i >= 0 ? process.argv[i + 1] : `docs-sim-${Date.now().toString(36)}`;
})();

// single-file is the bug this skill exists to kill, so it carries the most weight
// and a hard gate alongside the version bump. pdfDelivered is the format contract
// (the delivered artifact must be the rendered PDF, not the .html master) and is
// gated too. no-attach-on-minor is observed but not gated — it's a delivery nicety,
// and it's timing-sensitive (a slow first turn can push an earlier beat's reply into
// the minor-edit window), so it must never block the ship gates.
const DIMS = [
  { key: 'bumpOnUpdate', label: 'Version bumps on update', weight: 25, gate: 0.9 },
  { key: 'singleFile', label: 'No duplicate file (in place)', weight: 25, gate: 0.9 },
  { key: 'pdfDelivered', label: 'Delivers a rendered PDF', weight: 20, gate: 0.8 },
  { key: 'noBumpMinor', label: 'No bump on minor edit', weight: 15, gate: 0.8 },
  { key: 'deliverOnRequest', label: 'Sends file on explicit ask', weight: 10, gate: 0.8 },
  { key: 'noAttachMinor', label: 'No re-send on minor edit', weight: 5, gate: null },
] as const;

function readResults(): Record<string, boolean>[] {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stddev(xs: number[]): number { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }

console.log(`scoring trip-docs: ${K} live runs through the cli.sock pipeline…\n`);
const before = readResults().length;
for (let i = 1; i <= K; i++) {
  console.log(`── run ${i}/${K} ──`);
  const p = Bun.spawnSync(['bun', SIM, '--run', `${RUN}-${i}`], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  if (p.exitCode === 2 || p.exitCode === 3) { console.error(`run ${i} could not execute (exit ${p.exitCode}) — aborting score.`); process.exit(p.exitCode); }
}

const runs = readResults().slice(before, before + K);
if (runs.length === 0) { console.error('no results recorded — aborting.'); process.exit(1); }

let score = 0;
const card: { dim: string; passRate: number; stddev: number; gate: number | null; gated: string }[] = [];
for (const d of DIMS) {
  const xs = runs.map((r) => (r[d.key] ? 1 : 0));
  const pr = mean(xs);
  score += d.weight * pr;
  const gated = d.gate == null ? '—' : pr >= d.gate ? 'PASS' : 'FAIL';
  card.push({ dim: d.label, passRate: pr, stddev: stddev(xs), gate: d.gate, gated });
}

const shipGatesPass = card.filter((c) => c.gate != null).every((c) => c.gated === 'PASS');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join(LOG_DIR, `scorecard-${TS}.json`), JSON.stringify({ ts: TS, runs: K, score: Math.round(score), shipGatesPass, card }, null, 2));

console.log(`\n═══════════ trip-docs reliability scorecard (${K} runs) ═══════════`);
for (const c of card) {
  const pct = `${Math.round(c.passRate * 100)}%`.padStart(4);
  const sd = c.stddev ? ` ±${(c.stddev * 100).toFixed(0)}%` : '';
  const gate = c.gate == null ? '(not gated)' : `gate ≥${Math.round(c.gate * 100)}% → ${c.gated}`;
  console.log(`  ${c.dim.padEnd(32)} ${pct}${sd.padEnd(7)}  ${gate}`);
}
console.log(`  ${''.padEnd(32)} ${'─'.repeat(20)}`);
console.log(`  RELIABILITY SCORE: ${Math.round(score)}/100   ship-gates: ${shipGatesPass ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`  scorecard: ${join(LOG_DIR, `scorecard-${TS}.json`)}`);
process.exit(shipGatesPass ? 0 : 1);
