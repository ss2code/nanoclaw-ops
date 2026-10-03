#!/usr/bin/env bun
// Vision-parsing eval (design §8, Gate 2): for every fixture, ask the model to
// extract the payment record from the image, compare to the golden JSON, score.
//
// Drives the authenticated `claude` CLI in -p mode (subscription auth; the host
// deliberately has no ANTHROPIC_API_KEY). The model reads each image with its
// Read tool — the same vision path the container agent will use at runtime.
//
// Usage: bun vision-eval.ts [--model sonnet] [--limit N] [--only clean|degraded|real]
//                           [--concurrency 4] [--fixtures <dir>]
//
// Pass bars (design §10 Gate 2): clean — amount ≥98%, payer ≥95%, currency 100%.
// Degraded — zero confident-wrong parses (clarification is an acceptable outcome).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Golden {
  id: string;
  kind: 'upi' | 'bill';
  amount: string;
  currency: string;
  payer: string | null;
  payee_or_merchant: string;
  degradation: string | null;
  expected: 'extract' | 'extract-or-clarify';
}

interface Extraction {
  kind?: string;
  amount: string | number | null;
  currency: string | null;
  payer: string | null;
  payee_or_merchant: string | null;
  txn_id?: string | null;
  needs_clarification: boolean;
  reason?: string;
}

interface Result {
  id: string;
  bucket: string;
  golden: Golden;
  extraction: Extraction | null;
  error?: string;
  amountOk: boolean;
  currencyOk: boolean;
  payerOk: boolean | null; // null = golden has no payer → not scored
  clarified: boolean;
  confidentWrong: boolean;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const MODEL = arg('model', 'sonnet');
const LIMIT = Number(arg('limit', '0'));
const ONLY = arg('only', '');
const CONCURRENCY = Number(arg('concurrency', '4'));
const FIXTURES = resolve(arg('fixtures', join(import.meta.dir, 'fixtures')));

const PROMPT = (imgPath: string) => `Read the image file at ${imgPath} with the Read tool.

It is either a UPI payment screenshot (Paytm / GPay / PhonePe) or a photo of a printed bill or receipt. Extract the payment record.

Reply with ONLY a JSON object, no markdown fences, no prose:
{"kind": "upi" | "bill",
 "amount": "<decimal string, digits and one dot only, e.g. 1234.56>" | null,
 "currency": "<ISO 4217, e.g. INR>" | null,
 "payer": "<name of the person who PAID>" | null,
 "payee_or_merchant": "<recipient name or shop name>" | null,
 "txn_id": "<transaction/UPI reference>" | null,
 "needs_clarification": true | false,
 "reason": "<short note>"}

Rules:
- "payer" is the SENDER of the money. On UPI screens use the "From" / "Debited from" account holder name if shown. The "Paid to" name is the payee, never the payer. If no sender name is visible, payer is null.
- A wrong amount is worse than no amount. If any digit of the amount is not clearly readable, set amount to null and needs_clarification to true. NEVER guess digits.
- If the image is too blurry, dark, or cut off to read confidently, set needs_clarification to true.
- ₹ or "Rs." means INR.`;

function normAmountToCents(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[₹$,\s]|Rs\.?/gi, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

function nameMatches(got: string | null, want: string | null): boolean {
  if (!got || !want) return false;
  const a = got.toLowerCase().trim();
  const b = want.toLowerCase().trim();
  return a === b || a.includes(b) || b.includes(a);
}

async function runOne(pngPath: string, golden: Golden, bucket: string): Promise<Result> {
  const base: Omit<Result, 'extraction' | 'error'> = {
    id: golden.id, bucket, golden,
    amountOk: false, currencyOk: false, payerOk: golden.payer ? false : null,
    clarified: false, confidentWrong: false,
  };
  try {
    const proc = Bun.spawn(
      ['claude', '-p', PROMPT(pngPath), '--model', MODEL, '--output-format', 'json', '--max-turns', '6'],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
    );
    const timeout = setTimeout(() => proc.kill(), 180_000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timeout);
    const wrapper = JSON.parse(out);
    const text: string = wrapper.result ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ...base, extraction: null, error: `no JSON in response: ${text.slice(0, 120)}` };
    const ex = JSON.parse(jsonMatch[0]) as Extraction;

    const gotCents = normAmountToCents(ex.amount);
    const wantCents = normAmountToCents(golden.amount)!;
    const amountOk = gotCents === wantCents;
    const currencyOk = (ex.currency ?? '').toUpperCase() === golden.currency;
    const payerOk = golden.payer ? nameMatches(ex.payer, golden.payer) : null;
    const clarified = ex.needs_clarification === true;
    // The one unacceptable failure mode: a confident parse with a wrong (non-null) amount.
    const confidentWrong = !clarified && gotCents !== null && gotCents !== wantCents;

    return { ...base, extraction: ex, amountOk, currencyOk, payerOk, clarified, confidentWrong };
  } catch (err) {
    return { ...base, extraction: null, error: String(err) };
  }
}

function collect(dir: string, bucket: string): { png: string; golden: Golden; bucket: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const golden = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Golden;
      const png = join(dir, f.replace(/\.json$/, '.png'));
      return existsSync(png) ? { png, golden, bucket } : null;
    })
    .filter((x): x is { png: string; golden: Golden; bucket: string } => x !== null);
}

const pct = (num: number, den: number) => (den === 0 ? '—' : `${((100 * num) / den).toFixed(1)}% (${num}/${den})`);

async function main(): Promise<void> {
  let work = [
    ...collect(join(FIXTURES, 'synthetic', 'clean'), 'clean'),
    ...collect(join(FIXTURES, 'synthetic', 'degraded'), 'degraded'),
    ...collect(join(FIXTURES, 'real'), 'real'),
  ];
  if (ONLY) work = work.filter((w) => w.bucket === ONLY);
  if (LIMIT > 0) work = work.slice(0, LIMIT);
  if (work.length === 0) {
    console.error('no fixtures found — run `bun generate.ts` first');
    process.exit(1);
  }
  console.log(`evaluating ${work.length} fixtures with model "${MODEL}" (concurrency ${CONCURRENCY})\n`);

  const results: Result[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < work.length) {
      const w = work[next++];
      const res = await runOne(w.png, w.golden, w.bucket);
      results.push(res);
      const flag = res.error
        ? `ERROR ${res.error.slice(0, 80)}`
        : res.confidentWrong
          ? '✗ CONFIDENT-WRONG'
          : res.clarified
            ? '… clarified'
            : res.amountOk && res.currencyOk && res.payerOk !== false
              ? '✓'
              : `✗ amount:${res.amountOk} currency:${res.currencyOk} payer:${res.payerOk}`;
      console.log(`[${results.length}/${work.length}] ${res.bucket}/${res.id} ${flag}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const clean = results.filter((x) => x.bucket === 'clean' || x.bucket === 'real');
  const degraded = results.filter((x) => x.bucket === 'degraded');
  const cleanPayerScored = clean.filter((x) => x.payerOk !== null);
  const confidentWrongAll = results.filter((x) => x.confidentWrong);

  console.log('\n── Gate 2 report ──');
  console.log(`clean+real  amount   ${pct(clean.filter((x) => x.amountOk).length, clean.length)}   (bar ≥98%)`);
  console.log(`clean+real  currency ${pct(clean.filter((x) => x.currencyOk).length, clean.length)}   (bar 100%)`);
  console.log(`clean+real  payer    ${pct(cleanPayerScored.filter((x) => x.payerOk).length, cleanPayerScored.length)}   (bar ≥95%)`);
  console.log(`degraded    ok       ${pct(degraded.filter((x) => x.clarified || (x.amountOk && x.currencyOk)).length, degraded.length)}`);
  console.log(`confident-wrong parses: ${confidentWrongAll.length}   (bar: ZERO)`);
  for (const cw of confidentWrongAll) {
    console.log(`  ✗ ${cw.bucket}/${cw.id}: got ${cw.extraction?.amount}, truth ${cw.golden.amount}`);
  }

  const reportPath = join(FIXTURES, '..', 'eval-report.json');
  writeFileSync(reportPath, JSON.stringify({ model: MODEL, ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nfull report: ${reportPath}`);

  const cleanAmountPct = clean.length ? clean.filter((x) => x.amountOk).length / clean.length : 0;
  const cleanCurrencyOk = clean.every((x) => x.currencyOk);
  const payerPct = cleanPayerScored.length
    ? cleanPayerScored.filter((x) => x.payerOk).length / cleanPayerScored.length
    : 1;
  const pass = cleanAmountPct >= 0.98 && cleanCurrencyOk && payerPct >= 0.95 && confidentWrongAll.length === 0;
  console.log(pass ? '\nGATE 2: PASS' : '\nGATE 2: FAIL');
  process.exit(pass ? 0 : 1);
}

main();
