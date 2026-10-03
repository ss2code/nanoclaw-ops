/**
 * self-tests-suite — an umbrella for live, end-to-end validation suites that
 * exercise a running NanoClaw agent group through the real host path.
 *
 * Today it hosts one suite; more will slot in beside it (each a `suites/*.ts`
 * exporting a run function, registered in SUITES below).
 *
 *   pnpm exec tsx scripts/self-tests-suite/run.ts <suite> --group <agentGroupId> [flags]
 *   pnpm exec tsx scripts/self-tests-suite/run.ts list
 *
 * Suites:
 *   model-routing   Validate model-tier routing (default / [tier:X] / /model X).
 *
 * Flags:
 *   --group <id>    Target agent group id (required for a suite).            [required]
 *   --json          Emit the machine-readable report instead of the table.
 *   --timeout <ms>  Per-probe wait for a model turn (default 120000).
 *
 * Requires the host service running (cli.sock live). Each probe sends a real
 * message and consumes a real model turn on the group's provider.
 */
import Database from 'better-sqlite3';
import { PATHS } from '../../ops-center/config.js';
import { runModelRouting, type SuiteReport } from './suites/model-routing.js';

const SUITES: Record<string, { title: string; run: typeof runModelRouting }> = {
  'model-routing': { title: 'model-routing-test-suite', run: runModelRouting },
};

function groupName(agentGroupId: string): string {
  const db = new Database(PATHS.centralDb, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT name FROM agent_groups WHERE id = ?').get(agentGroupId) as
      | { name: string }
      | undefined;
    if (!row) throw new Error(`unknown agent group: ${agentGroupId}`);
    return row.name;
  } finally {
    db.close();
  }
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function printReport(rep: SuiteReport): void {
  const line = '─'.repeat(78);
  console.log(`\n${line}`);
  console.log(`model-routing-test-suite · ${rep.agentGroupId} · provider=${rep.provider}`);
  console.log(
    `tiers: high=${rep.tiers.high}  medium=${rep.tiers.medium}  low=${rep.tiers.low}  default=${rep.tiers.default}`,
  );
  console.log(line);
  for (const c of rep.cases) {
    const mark = c.pass ? '✅' : '❌';
    console.log(`${mark}  ${c.name.padEnd(18)} ${c.path.padEnd(16)} ${c.detail}`);
  }
  console.log(line);
  const verdict = rep.failed === 0 ? '✅ ALL PASS' : `❌ ${rep.failed} FAILED`;
  console.log(`${verdict}   (${rep.passed}/${rep.cases.length} passed)`);
  console.log(`${line}\n`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd || cmd === 'list' || cmd === 'help') {
    console.log('self-tests-suite — live validation suites\n');
    console.log('suites:');
    for (const [k, v] of Object.entries(SUITES)) console.log(`  ${k.padEnd(16)} ${v.title}`);
    console.log('\nusage: pnpm exec tsx scripts/self-tests-suite/run.ts <suite> --group <agentGroupId> [--json] [--timeout ms]');
    process.exit(cmd ? 0 : 1);
  }
  const suite = SUITES[cmd];
  if (!suite) {
    console.error(`unknown suite "${cmd}". Run "list" to see suites.`);
    process.exit(1);
  }
  const group = flag('group');
  if (!group) {
    console.error(`--group <agentGroupId> is required for ${cmd}`);
    process.exit(1);
  }
  const timeoutMs = Number(flag('timeout') ?? 120_000);
  const name = groupName(group);

  console.error(`[self-tests-suite] running ${cmd} against ${group} (${name})`);
  const rep = await suite.run(group, name, {
    timeoutMs,
    pollMs: 2000,
    settleMs: 3000,
    log: (s) => console.error(`  ${s}`),
  });

  if (has('json')) {
    console.log(JSON.stringify(rep, null, 2));
  } else {
    printReport(rep);
  }
  process.exit(rep.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('self-tests-suite error:', err instanceof Error ? err.message : err);
  process.exit(2);
});
