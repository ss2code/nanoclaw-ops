#!/usr/bin/env -S pnpm exec tsx
/**
 * Explicit maintenance command for Reflect's improvement history.
 *
 * This command is intentionally separate from scripts/reflect.ts. Use it only
 * after the operator has approved a repair or status update.
 */
import fs from 'fs';

import { PATHS } from '../ops-center/config.js';
import {
  readImprovementLedger,
  upsertImprovement,
  type ImprovementEntry,
} from '../ops-center/reflect/ledger.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function usage(): string {
  return [
    'reflect-ledger — explicit approved-repair history maintenance',
    '',
    '  list [--json]',
    '  record --entry /absolute/path/to/entry.json',
    '',
    `Ledger: ${PATHS.reflectImprovements}`,
    '',
    'The entry JSON must include id, signalIds, title, status, firstSeenAt,',
    'updatedAt, rootCause, changeSummary, changedFiles, and verification.',
    'Recording replaces the same id while preserving its original firstSeenAt.',
  ].join('\n');
}

function main(): number {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return 0;
  }
  if (command === 'list') {
    const ledger = readImprovementLedger();
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify(ledger, null, 2));
    } else if (!ledger.entries.length) {
      console.log('No Reflect improvements recorded.');
    } else {
      for (const entry of ledger.entries) {
        console.log(`${entry.updatedAt}  ${entry.status.padEnd(13)}  ${entry.id}  ${entry.title}`);
      }
      for (const warning of ledger.warnings) console.error(`warning: ${warning}`);
    }
    return 0;
  }
  if (command === 'record') {
    const entryPath = flag('entry');
    if (!entryPath) throw new Error('record requires --entry /absolute/path/to/entry.json');
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8')) as ImprovementEntry;
    const saved = upsertImprovement(entry);
    console.log(`Recorded ${saved.id} as ${saved.status} in ${PATHS.reflectImprovements}`);
    return 0;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
