import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { OperationRow } from './opsdb.js';

export interface VerificationResult {
  ok: boolean;
  state: unknown;
  message: string;
}

export interface OperationSpec {
  kind: string;
  scopeType: 'host' | 'group' | 'system';
  scopeId?: string;
  before: unknown;
  rollback?: unknown;
  /** Compensating action. Runs only when execute/verify does not succeed. */
  rollbackExecute?: () => Promise<{ ok: boolean; message: string }>;
  /** Proves the compensating action restored its declared postcondition. */
  rollbackVerify?: () => Promise<VerificationResult>;
  execute: () => Promise<{ ok: boolean; message: string }>;
  verify: () => Promise<VerificationResult>;
}

export interface OperationOutcome {
  ok: boolean;
  operationId: string;
  status: OperationRow['status'];
  message: string;
}

export async function pollUntil(
  probe: () => Promise<VerificationResult>,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<VerificationResult> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!last.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await probe();
  }
  return last;
}

/** Journal an operation from preflight through verified postcondition. */
export async function runVerifiedOperation(db: Database.Database, spec: OperationSpec): Promise<OperationOutcome> {
  const id = randomUUID();
  const started = new Date().toISOString();
  db.prepare(
    `INSERT INTO operations
      (id, kind, scope_type, scope_id, status, started_at, before_json, rollback_json)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
  ).run(
    id,
    spec.kind,
    spec.scopeType,
    spec.scopeId ?? null,
    started,
    JSON.stringify(spec.before ?? null),
    spec.rollback == null ? null : JSON.stringify(spec.rollback),
  );

  let status: OperationRow['status'] = 'failed';
  let after: unknown = null;
  let result = '';
  try {
    const execution = await spec.execute();
    result = execution.message;
    if (execution.ok) {
      const verification = await spec.verify();
      after = verification.state;
      result = `${execution.message}; verification: ${verification.message}`;
      status = verification.ok ? 'succeeded' : 'unverified';
    }
  } catch (error) {
    result = (error as Error).message;
  }
  if (status !== 'succeeded' && spec.rollbackExecute) {
    try {
      const rollback = await spec.rollbackExecute();
      result += `; rollback: ${rollback.message}`;
      if (rollback.ok) {
        const verification = spec.rollbackVerify
          ? await spec.rollbackVerify()
          : { ok: true, state: spec.rollback ?? null, message: 'rollback action completed' };
        after = { failedState: after, rollbackState: verification.state };
        result += `; rollback verification: ${verification.message}`;
        if (verification.ok) {
          status = 'rolled_back';
          result += '; rollback verified';
        }
      }
    } catch (error) {
      result += `; rollback failed: ${(error as Error).message}`;
    }
  }
  const finished = new Date().toISOString();
  db.prepare(`UPDATE operations SET status = ?, finished_at = ?, after_json = ?, result = ? WHERE id = ?`).run(
    status,
    finished,
    JSON.stringify(after),
    result.slice(0, 2000),
    id,
  );
  return { ok: status === 'succeeded', operationId: id, status, message: `${result} [operation ${id.slice(0, 8)}]` };
}

export function saveConfigSnapshot(
  db: Database.Database,
  groupId: string,
  kind: string,
  config: unknown,
  operationId?: string,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO config_snapshots (id, ts, group_id, kind, config_json, operation_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, new Date().toISOString(), groupId, kind, JSON.stringify(config), operationId ?? null);
  return id;
}

export function latestConfigSnapshot(
  db: Database.Database,
  groupId: string,
  kind: string,
): { id: string; config: Record<string, unknown>; ts: string } | undefined {
  const row = db
    .prepare(
      `SELECT id, ts, config_json FROM config_snapshots
       WHERE group_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(groupId, kind) as { id: string; ts: string; config_json: string } | undefined;
  return row ? { id: row.id, ts: row.ts, config: JSON.parse(row.config_json) } : undefined;
}
