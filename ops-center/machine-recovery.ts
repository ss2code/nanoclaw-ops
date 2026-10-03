/**
 * Host-side launcher and read-only status reader for an optional recovery
 * script. The script owns any privileged/runtime work; Ops Center only starts
 * an explicitly configured local script and reads its non-secret state/report
 * files.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { PATHS, ROOT } from './config.js';

export type RecoveryPhase =
  | 'preparing'
  | 'reboot-requested'
  | 'recovering'
  | 'postcheck-running'
  | 'auth-renewing'
  | 'complete'
  | 'failed';

export interface RecoveryState {
  version: number;
  jobId: string;
  expectedHost: string;
  phase: RecoveryPhase;
  message: string;
  reportPath: string | null;
  logPath: string | null;
  authPending: boolean;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface RecoveryReport {
  version: number;
  jobId: string;
  host: string;
  expectedHost: string;
  startedAt: string;
  finishedAt: string;
  overall: 'pass' | 'warn' | 'fail';
  failures: number;
  warnings: number;
  checks: { name: string; status: 'pass' | 'warn' | 'fail'; detail: string }[];
}

export interface RecoveryStatus {
  state: RecoveryState | null;
  report: RecoveryReport | null;
}

const PHASES = new Set<RecoveryPhase>([
  'preparing',
  'reboot-requested',
  'recovering',
  'postcheck-running',
  'auth-renewing',
  'complete',
  'failed',
]);

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export function readRecoveryState(file = PATHS.remoteRecoveryState): RecoveryState | null {
  const value = readJson(file);
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.jobId !== 'string' ||
    typeof row.expectedHost !== 'string' ||
    typeof row.phase !== 'string' ||
    !PHASES.has(row.phase as RecoveryPhase) ||
    typeof row.message !== 'string' ||
    typeof row.startedAt !== 'string' ||
    typeof row.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    version: 1,
    jobId: row.jobId,
    expectedHost: row.expectedHost,
    phase: row.phase as RecoveryPhase,
    message: row.message,
    reportPath: typeof row.reportPath === 'string' ? row.reportPath : null,
    logPath: typeof row.logPath === 'string' ? row.logPath : null,
    authPending: row.authPending !== false,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    ...(typeof row.finishedAt === 'string' ? { finishedAt: row.finishedAt } : {}),
  };
}

function reportFileFor(state: RecoveryState | null): string | null {
  if (!state?.reportPath) return null;
  const candidate = path.resolve(ROOT, state.reportPath);
  const base = path.resolve(PATHS.remoteRecoveryDir) + path.sep;
  if (!candidate.startsWith(base)) return null;
  return candidate;
}

export function readRecoveryReport(state: RecoveryState | null): RecoveryReport | null {
  const file = reportFileFor(state);
  if (!file) return null;
  const value = readJson(file);
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    row.jobId !== state?.jobId ||
    typeof row.jobId !== 'string' ||
    typeof row.host !== 'string' ||
    typeof row.expectedHost !== 'string' ||
    typeof row.startedAt !== 'string' ||
    typeof row.finishedAt !== 'string' ||
    (row.overall !== 'pass' && row.overall !== 'warn' && row.overall !== 'fail') ||
    !Array.isArray(row.checks)
  ) {
    return null;
  }
  const checks = row.checks
    .filter((check): check is Record<string, unknown> => Boolean(check && typeof check === 'object'))
    .filter(
      (check) =>
        typeof check.name === 'string' &&
        (check.status === 'pass' || check.status === 'warn' || check.status === 'fail') &&
        typeof check.detail === 'string',
    )
    .map((check) => ({
      name: check.name as string,
      status: check.status as 'pass' | 'warn' | 'fail',
      detail: check.detail as string,
    }));
  return {
    version: 1,
    jobId: row.jobId,
    host: row.host,
    expectedHost: row.expectedHost,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    overall: row.overall as 'pass' | 'warn' | 'fail',
    failures:
      typeof row.failures === 'number' ? row.failures : checks.filter((check) => check.status === 'fail').length,
    warnings:
      typeof row.warnings === 'number' ? row.warnings : checks.filter((check) => check.status === 'warn').length,
    checks,
  };
}

export function recoveryStatus(): RecoveryStatus {
  const state = readRecoveryState();
  return { state, report: readRecoveryReport(state) };
}

export type RecoveryAction = 'recover' | 'reboot' | 'postcheck';

export interface RecoveryActionResult {
  ok: boolean;
  message: string;
}

function active(state: RecoveryState | null): boolean {
  if (!state || state.phase === 'complete' || state.phase === 'failed') return false;
  const updated = Date.parse(state.updatedAt);
  return Number.isFinite(updated) && Date.now() - updated < 2 * 60 * 60 * 1000;
}

function configuredRecoveryScript(): string | null {
  const raw = process.env.NANOCLAW_RECOVERY_SCRIPT?.trim();
  if (!raw) return null;

  const root = path.resolve(ROOT);
  const candidate = path.resolve(ROOT, raw);
  const base = root + path.sep;
  if (!candidate.startsWith(base)) return null;

  try {
    const resolved = fs.realpathSync(candidate);
    if (!resolved.startsWith(base) || !fs.statSync(resolved).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** Start one fixed, locally configured script mode. No browser-supplied shell is accepted. */
export function startRecovery(action: RecoveryAction): RecoveryActionResult {
  const current = readRecoveryState();
  if (active(current)) {
    return {
      ok: false,
      message: `Recovery job ${current?.jobId} is already ${current?.phase}; inspect System for progress.`,
    };
  }
  const script = configuredRecoveryScript();
  if (!script) {
    return {
      ok: false,
      message: 'Optional host recovery is not configured for this installation.',
    };
  }
  const args = action === 'recover' ? ['--recover'] : action === 'reboot' ? ['--reboot'] : ['--postcheck'];
  const child = spawn('bash', [script, ...args], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  const label = action === 'reboot' ? 'reboot/recovery' : action === 'recover' ? 'runtime recovery' : 'post-check';
  return { ok: true, message: `${label} started in the background; refresh this card for the report.` };
}
