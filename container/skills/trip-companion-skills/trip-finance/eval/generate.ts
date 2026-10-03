#!/usr/bin/env bun
// Generates the synthetic vision-eval corpus: clean UPI/bill renders + degraded
// variants, each with a golden JSON. Deterministic (seeded) so the corpus is
// reproducible — PNGs are regenerable build artifacts, goldens define truth.
//
// Usage: bun generate.ts [--out <dir>]   (default: eval/fixtures/synthetic)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderBill, renderDegradation, renderUpi, type BillSpec, type UpiSpec } from './templates';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(20261210);
const randInt = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(arr: readonly T[]): T => arr[randInt(0, arr.length - 1)];

const NAMES = [
  'Raj Mehta', 'Diya Kapoor', 'Vikram Iyer', 'Lakshmi Iyer', 'Dev Anand', 'Tara Kapoor',
  'Arjun Kapoor', 'Meera Mehta', 'Anil Kumar', 'Sunita Sharma', 'Rohit Verma', 'Kavya Nair',
] as const;
const BANKS = ['HDFC Bank', 'ICICI Bank', 'SBI', 'Axis Bank', 'Kotak Bank'] as const;
const MERCHANTS = [
  'Souza Lobo Beach Shack', 'Goa Fuel Station', 'Anjuna Mini Mart', 'Fisherman’s Wharf',
  'Cafe Lilliput', 'Baga Supermart', 'Thalassa Restaurant', 'Vagator Fresh Juice',
] as const;
const ITEM_NAMES = [
  'Fish Curry', 'Prawn Fry', 'Veg Thali', 'Kingfisher 650ml', 'Lime Soda', 'Garlic Naan',
  'Chicken Cafreal', 'Bebinca', 'Mineral Water', 'Masala Papad', 'Petrol 95', 'Sunscreen SPF50',
] as const;

function amountMajor(): string {
  // mix of round and crumb-heavy amounts, ₹40 – ₹25,000
  const paise = r() < 0.4 ? 0 : randInt(1, 99);
  return `${randInt(40, 25_000)}.${String(paise).padStart(2, '0')}`;
}
const txnId = () => `T${randInt(2026, 2026)}${String(randInt(0, 999999999)).padStart(9, '0')}${String(randInt(0, 9999)).padStart(4, '0')}`;
const dateText = () => `${randInt(20, 27)} Dec 2026, ${randInt(8, 22)}:${String(randInt(0, 59)).padStart(2, '0')}`;

interface Golden {
  id: string;
  kind: 'upi' | 'bill';
  style: string;
  amount: string; // major units, "1234.56"
  currency: 'INR';
  payer: string | null; // sender account holder when shown on screen; null → fall back to message sender
  payee_or_merchant: string;
  txn_id: string | null;
  degradation: string | null;
  // clean → must extract; degraded → extracting correctly OR asking to clarify both pass.
  expected: 'extract' | 'extract-or-clarify';
}

function screenshot(html: string, width: number, height: number, outPng: string): void {
  const tmpHtml = outPng.replace(/\.png$/, '.tmp.html');
  writeFileSync(tmpHtml, html);
  const proc = Bun.spawnSync(
    [
      CHROME, '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
      `--screenshot=${outPng}`, `--window-size=${width},${height}`, `file://${tmpHtml}`,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  rmSync(tmpHtml);
  if (proc.exitCode !== 0) throw new Error(`chrome screenshot failed for ${outPng}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const base = resolve(outIdx >= 0 ? args[outIdx + 1] : join(import.meta.dir, 'fixtures', 'synthetic'));
  const cleanDir = join(base, 'clean');
  const degradedDir = join(base, 'degraded');
  rmSync(base, { recursive: true, force: true });
  mkdirSync(cleanDir, { recursive: true });
  mkdirSync(degradedDir, { recursive: true });

  const cleanFixtures: { golden: Golden; width: number; height: number }[] = [];

  // ── 22 clean UPI screens (8 paytm, 8 gpay, 6 phonepe) ──
  const upiStyles: UpiSpec['style'][] = [
    ...Array(8).fill('paytm'), ...Array(8).fill('gpay'), ...Array(6).fill('phonepe'),
  ];
  upiStyles.forEach((style, i) => {
    const payee = pick(NAMES);
    let payer: string | null = r() < 0.7 ? pick(NAMES) : null;
    if (payer === payee) payer = null;
    const spec: UpiSpec = {
      style, amountMajor: amountMajor(), payee, payerName: payer, bank: pick(BANKS), txnId: txnId(), dateText: dateText(),
    };
    const id = `${style}-${String(i + 1).padStart(2, '0')}`;
    const { html, width, height } = renderUpi(spec);
    screenshot(html, width, height, join(cleanDir, `${id}.png`));
    const golden: Golden = {
      id, kind: 'upi', style, amount: spec.amountMajor, currency: 'INR', payer: spec.payerName,
      payee_or_merchant: spec.payee, txn_id: spec.txnId, degradation: null, expected: 'extract',
    };
    writeFileSync(join(cleanDir, `${id}.json`), JSON.stringify(golden, null, 2));
    cleanFixtures.push({ golden, width, height });
    console.log(`clean ${id}`);
  });

  // ── 8 clean bills (5 itemised, 3 totals-only) ──
  for (let i = 0; i < 8; i++) {
    const itemised = i < 5;
    // priceMajor is the LINE total (qty already applied) so the printed bill is
    // internally consistent: sum(AMT column) + GST === TOTAL.
    const items = itemised
      ? Array.from({ length: randInt(3, 7) }, () => {
          const qty = randInt(1, 4);
          return { name: pick(ITEM_NAMES), qty, priceMajor: `${qty * randInt(40, 900)}.00` };
        })
      : [];
    const subtotal = itemised
      ? items.reduce((a, it) => a + Number(it.priceMajor), 0)
      : randInt(200, 9000);
    const gst = Math.round(subtotal * 5) / 100;
    const total = (subtotal + gst).toFixed(2);
    const spec: BillSpec = {
      style: itemised ? 'bill-itemised' : 'bill-total',
      merchant: pick(MERCHANTS), addressLine: 'Calangute–Baga Rd, Goa 403516 · GSTIN 30AABCU9603R1ZX',
      items, totalMajor: total, gstMajor: gst.toFixed(2), dateText: dateText(),
      billNo: `B-${randInt(1000, 9999)}`,
    };
    const id = `${spec.style}-${String(i + 1).padStart(2, '0')}`;
    const { html, width, height } = renderBill(spec);
    screenshot(html, width, height, join(cleanDir, `${id}.png`));
    const golden: Golden = {
      id, kind: 'bill', style: spec.style, amount: total, currency: 'INR', payer: null,
      payee_or_merchant: spec.merchant, txn_id: null, degradation: null, expected: 'extract',
    };
    writeFileSync(join(cleanDir, `${id}.json`), JSON.stringify(golden, null, 2));
    cleanFixtures.push({ golden, width, height });
    console.log(`clean ${id}`);
  }

  // ── 20 degraded variants over the first clean fixtures ──
  const kinds = ['blur', 'lowlight', 'rotate', 'crop', 'heavy-blur'] as const;
  for (let i = 0; i < 20; i++) {
    const src = cleanFixtures[i % cleanFixtures.length];
    const kind = kinds[i % kinds.length];
    const id = `${src.golden.id}-${kind}`;
    const { html, width, height } = renderDegradation(
      `file://${join(cleanDir, `${src.golden.id}.png`)}`, src.width, src.height, kind,
    );
    screenshot(html, width, height, join(degradedDir, `${id}.png`));
    const golden: Golden = {
      ...src.golden, id, degradation: kind, expected: 'extract-or-clarify',
    };
    writeFileSync(join(degradedDir, `${id}.json`), JSON.stringify(golden, null, 2));
    console.log(`degraded ${id}`);
  }

  console.log(`\nCorpus written to ${base}: ${cleanFixtures.length} clean + 20 degraded`);
}

main();
