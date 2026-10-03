/**
 * Durable Reflect improvement history.
 *
 * Diagnostic paths call readImprovementLedger only. Mutations are deliberately
 * separate and are used by scripts/reflect-ledger.ts after an operator approves
 * a repair, so running /reflect can never accept or apply its own suggestions.
 */
import fs from 'fs';
import path from 'path';

import { PATHS } from '../config.js';

export type ImprovementStatus = 'diagnosed' | 'fixed' | 'verified' | 'regressed' | 'accepted-risk';

export interface ImprovementEntry {
  id: string;
  signalIds: string[];
  title: string;
  status: ImprovementStatus;
  firstSeenAt: string;
  updatedAt: string;
  rootCause: string;
  changeSummary: string;
  changedFiles: string[];
  introducingCommit?: string | null;
  repairCommit?: string | null;
  verification: string[];
  before?: Record<string, number | string | null>;
  after?: Record<string, number | string | null>;
  notes?: string[];
}

interface ImprovementLedger {
  version: 1;
  entries: ImprovementEntry[];
}

export interface ImprovementLedgerRead {
  entries: ImprovementEntry[];
  warnings: string[];
}

const STATUSES = new Set<ImprovementStatus>(['diagnosed', 'fixed', 'verified', 'regressed', 'accepted-risk']);
const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 512 * 1024;

function strings(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === 'string' && item.length <= maxLength)
  );
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validEntry(value: unknown): value is ImprovementEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ImprovementEntry>;
  return (
    typeof entry.id === 'string' &&
    /^[a-z0-9][a-z0-9-]{1,79}$/.test(entry.id) &&
    strings(entry.signalIds, 20, 160) &&
    typeof entry.title === 'string' &&
    entry.title.length <= 240 &&
    STATUSES.has(entry.status as ImprovementStatus) &&
    validIso(entry.firstSeenAt) &&
    validIso(entry.updatedAt) &&
    typeof entry.rootCause === 'string' &&
    entry.rootCause.length <= 4_000 &&
    typeof entry.changeSummary === 'string' &&
    entry.changeSummary.length <= 4_000 &&
    strings(entry.changedFiles, 80, 500) &&
    strings(entry.verification, 40, 1_000) &&
    (entry.notes == null || strings(entry.notes, 40, 1_000)) &&
    JSON.stringify(entry.before ?? {}).length <= 20_000 &&
    JSON.stringify(entry.after ?? {}).length <= 20_000
  );
}

export function readImprovementLedger(
  ledgerPath = PATHS.reflectImprovements,
): ImprovementLedgerRead {
  if (!fs.existsSync(ledgerPath)) return { entries: [], warnings: [] };
  try {
    if (fs.statSync(ledgerPath).size > MAX_FILE_BYTES) {
      return { entries: [], warnings: [`Reflect improvement history at ${ledgerPath} exceeds ${MAX_FILE_BYTES} bytes.`] };
    }
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Partial<ImprovementLedger>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { entries: [], warnings: [`Reflect improvement history at ${ledgerPath} has an unsupported schema.`] };
    }
    const valid = parsed.entries.filter(validEntry);
    const warnings =
      valid.length === parsed.entries.length
        ? []
        : [`Reflect improvement history ignored ${parsed.entries.length - valid.length} invalid entry/entries.`];
    return {
      entries: valid
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_ENTRIES),
      warnings,
    };
  } catch (error) {
    return {
      entries: [],
      warnings: [`Reflect improvement history at ${ledgerPath} is unreadable: ${message(error)}.`],
    };
  }
}

/**
 * Explicit repair-workflow mutation. Never call this from buildEvidencePack,
 * Ops Center's /reflect endpoint, or the reflect skill itself.
 */
export function upsertImprovement(
  entry: ImprovementEntry,
  ledgerPath = PATHS.reflectImprovements,
): ImprovementEntry {
  if (!validEntry(entry)) throw new Error('invalid improvement entry');
  const existing = readImprovementLedger(ledgerPath);
  if (existing.warnings.length && fs.existsSync(ledgerPath)) {
    throw new Error(`refusing to overwrite invalid improvement history: ${existing.warnings.join(' ')}`);
  }
  const previous = existing.entries.find((item) => item.id === entry.id);
  const normalized: ImprovementEntry = {
    ...entry,
    firstSeenAt: previous?.firstSeenAt ?? entry.firstSeenAt,
  };
  const entries = [
    normalized,
    ...existing.entries.filter((item) => item.id !== normalized.id),
  ]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_ENTRIES);
  const directory = path.dirname(ledgerPath);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${ledgerPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temp, ledgerPath);
  return normalized;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
