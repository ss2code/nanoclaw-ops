#!/usr/bin/env -S pnpm exec tsx
/**
 * Read-only execution-health digest.
 *
 * This command opens ops.db read-only, reads existing execution traces, performs
 * deterministic arithmetic, and prints the result. It has no mutation commands.
 */
import fs from 'fs';
import Database from 'better-sqlite3';

import { PATHS } from '../ops-center/config.js';
import { buildEvidencePack } from '../ops-center/reflect/digest.js';
import { renderDigest } from '../ops-center/reflect/report.js';
import { computeSignals } from '../ops-center/reflect/signals.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function integerFlag(name: string, fallback: number, min: number, max: number): number {
  const raw = flag(name);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function openOpsDbReadOnly(): { db: Database.Database | null; reason?: string } {
  if (!fs.existsSync(PATHS.opsDb)) {
    return { db: null, reason: `ops.db does not exist at ${PATHS.opsDb}` };
  }
  try {
    return { db: new Database(PATHS.opsDb, { readonly: true, fileMustExist: true }) };
  } catch (error) {
    return { db: null, reason: `ops.db could not be opened read-only: ${message(error)}` };
  }
}

function usage(): string {
  return [
    'reflect — read-only NanoClaw execution-health digest',
    '',
    '  digest [--days 7] [--group ID] [--exhibits 12] [--json]',
    '      Read existing traces and ops data. No model calls and no writes.',
    '',
    'Examples:',
    '  pnpm exec tsx scripts/reflect.ts digest',
    '  pnpm exec tsx scripts/reflect.ts digest --days 14 --group ag-123',
    '  pnpm exec tsx scripts/reflect.ts digest --json',
  ].join('\n');
}

async function main(): Promise<number> {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(usage());
    return 0;
  }
  if (cmd !== 'digest') {
    console.error(`Unknown command: ${cmd}\n\n${usage()}`);
    return 2;
  }

  const days = integerFlag('days', 7, 1, 30);
  const exhibitLimit = integerFlag('exhibits', 12, 0, 30);
  const opened = openOpsDbReadOnly();
  try {
    const pack = buildEvidencePack(opened.db, {
      windowDays: days,
      groupId: flag('group'),
      exhibitLimit,
      opsDbUnavailableReason: opened.reason,
    });
    const signals = computeSignals(pack);
    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify({ pack, signals }, null, 2));
    } else {
      console.log(renderDigest(pack, signals));
    }
    return 0;
  } finally {
    opened.db?.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(message(error));
    process.exit(2);
  });

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
