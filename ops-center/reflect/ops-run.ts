/**
 * The user-triggered Ops Center entry point for the read-only Reflect digest.
 *
 * The slash skill and the Ops Center button deliberately share the same digest
 * engine. This module keeps the latest result in process memory and mirrors it
 * to one bounded JSON snapshot for reloads; it only reads the separately
 * maintained improvement history and does not schedule or change runtime state.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

import { PATHS } from '../config.js';
import { buildEvidencePack, type DigestOptions, type EvidencePack } from './digest.js';
import { computeSignals, type ReflectLane, type Signal } from './signals.js';

export type ReflectRunStatus = 'never' | 'complete' | 'error';

export interface ReflectRunState {
  runId: string | null;
  status: ReflectRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  windowDays: number;
  groupId: string | null;
  pack: EvidencePack | null;
  signals: Signal[];
  error: string | null;
  snapshotSaved: boolean;
  snapshotError: string | null;
}

const initialState = (): ReflectRunState => ({
  runId: null,
  status: 'never',
  startedAt: null,
  finishedAt: null,
  windowDays: 7,
  groupId: null,
  pack: null,
  signals: [],
  error: null,
  snapshotSaved: false,
  snapshotError: null,
});

const SNAPSHOT_VERSION = 2;

function usableSnapshot(value: unknown): value is Partial<ReflectRunState> & { version: number } {
  if (!value || typeof value !== 'object') return false;
  const parsed = value as Partial<ReflectRunState> & { version?: number };
  const pack = parsed.pack;
  const health = pack?.health;
  const fleet = pack?.fleet;
  const outcomes = fleet?.outcomes;
  return (
    parsed.version === SNAPSHOT_VERSION &&
    parsed.status === 'complete' &&
    typeof parsed.finishedAt === 'string' &&
    Array.isArray(parsed.signals) &&
    !!pack &&
    !!health &&
    typeof health.complete === 'boolean' &&
    Array.isArray(health.warnings) &&
    !!fleet &&
    !!outcomes &&
    typeof outcomes.working === 'number' &&
    typeof fleet.costUsd === 'number' &&
    Array.isArray(pack.exhibits)
  );
}

function loadLatestReflectRun(): ReflectRunState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(PATHS.reflectLatest, 'utf8'));
    if (!usableSnapshot(parsed)) return initialState();
    return {
      ...initialState(),
      ...parsed,
      snapshotSaved: true,
      snapshotError: null,
    } as ReflectRunState;
  } catch {
    return initialState();
  }
}

function persistLatestReflectRun(state: ReflectRunState): void {
  const directory = path.dirname(PATHS.reflectLatest);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${PATHS.reflectLatest}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: SNAPSHOT_VERSION, ...state }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temp, PATHS.reflectLatest);
}

let latest: ReflectRunState = loadLatestReflectRun();

export interface OpsReflectOptions {
  windowDays?: number;
  groupId?: string;
  exhibitLimit?: number;
  lanes?: ReflectLane[];
}

export function getLatestReflectRun(): ReflectRunState {
  return latest;
}

/** Run once because the operator explicitly requested it from Ops Center. */
export function runReflectFromOpsCenter(opsDb: Database.Database, options: OpsReflectOptions = {}): ReflectRunState {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const windowDays = options.windowDays ?? 7;
  const groupId = options.groupId ?? null;
  latest = {
    runId,
    status: 'never',
    startedAt,
    finishedAt: null,
    windowDays,
    groupId,
    pack: null,
    signals: [],
    error: null,
    snapshotSaved: false,
    snapshotError: null,
  };

  try {
    const digestOptions: DigestOptions = {
      windowDays,
      groupId: groupId ?? undefined,
      exhibitLimit: options.exhibitLimit ?? 8,
    };
    const pack = buildEvidencePack(opsDb, digestOptions);
    const completed: ReflectRunState = {
      ...latest,
      status: 'complete',
      finishedAt: new Date().toISOString(),
      pack,
      signals: computeSignals(pack, options.lanes),
    };
    try {
      persistLatestReflectRun({ ...completed, snapshotSaved: true, snapshotError: null });
      latest = { ...completed, snapshotSaved: true, snapshotError: null };
    } catch (error) {
      latest = {
        ...completed,
        snapshotSaved: false,
        snapshotError: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    latest = {
      ...latest,
      status: 'error',
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      snapshotSaved: false,
      snapshotError: null,
    };
  }
  return latest;
}

export function reflectRunResponse(state: ReflectRunState): Record<string, unknown> {
  return {
    runId: state.runId,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    windowDays: state.windowDays,
    groupId: state.groupId,
    evidence: state.pack?.health.complete ? 'complete' : state.pack ? 'partial' : null,
    signalCount: state.signals.length,
    snapshotSaved: state.snapshotSaved,
    snapshotError: state.snapshotError,
    error: state.error,
  };
}

/** Reset only for isolated tests; production code never calls this. */
export function resetLatestReflectRunForTests(): void {
  latest = initialState();
}
