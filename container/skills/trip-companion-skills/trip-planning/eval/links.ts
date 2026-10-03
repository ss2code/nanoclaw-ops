#!/usr/bin/env bun
// Gate 2 (design §21): every proposed link in the plan must return 2xx.
// Run at generation and in CI — dead links can't ship.
//
// Usage: bun eval/links.ts --db /path/to/trip.db [--timeout 8000]

import { Database } from 'bun:sqlite';
import { checkUrls, collectPlanUrls, httpFetcher } from '../scripts/links';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const dbPath = arg('db', './trip.db');
  const timeout = Number(arg('timeout', '8000'));
  const db = new Database(dbPath, { readonly: true });
  const urls = collectPlanUrls(db);
  db.close();

  if (urls.length === 0) {
    console.log('Gate 2 (URL validity): no links in the plan yet — nothing to check.');
    process.exit(0);
  }
  console.log(`Gate 2 (URL validity): checking ${[...new Set(urls)].length} unique link(s)…\n`);
  const results = await checkUrls(urls, (u) => httpFetcher(u, timeout));
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} [${r.status ?? 'ERR'}] ${r.url}`);
  console.log(`\n── Gate 2: ${bad.length === 0 ? 'PASS' : `FAIL (${bad.length} dead link(s))`} ──`);
  process.exit(bad.length === 0 ? 0 : 1);
}

main();
