import { getDb } from './db/connection.js';
import { getSessionsByAgentGroup } from './db/sessions.js';

export type AgentGroupDesiredState = 'running' | 'stopped' | 'paused';
export type AgentGroupLifecycleStatus = 'running' | 'idle' | 'stopped' | 'paused' | 'starting' | 'error';
export type WakeSource = 'message' | 'scheduled' | 'automatic' | 'manual';

export interface AgentGroupControl {
  agent_group_id: string;
  desired_state: AgentGroupDesiredState;
  lifecycle_status: AgentGroupLifecycleStatus;
  revision: number;
  updated_at: string;
  updated_by: string;
  last_error: string | null;
}

export interface WakeLease {
  revision: number;
  source: WakeSource;
}

function ensureRow(agentGroupId: string): AgentGroupControl | undefined {
  const db = getDb();
  const group = db.prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(agentGroupId);
  if (!group) return undefined;
  db.prepare(
    `INSERT OR IGNORE INTO agent_group_lifecycle
     (agent_group_id, desired_state, lifecycle_status, revision, updated_at, updated_by)
     VALUES (?, 'running', 'idle', 0, ?, 'host')`,
  ).run(agentGroupId, new Date().toISOString());
  return db
    .prepare('SELECT * FROM agent_group_lifecycle WHERE agent_group_id = ?')
    .get(agentGroupId) as AgentGroupControl;
}

export function getAgentGroupControl(agentGroupId: string): AgentGroupControl | undefined {
  return ensureRow(agentGroupId);
}

export function listAgentGroupControls(): AgentGroupControl[] {
  return getDb().prepare('SELECT * FROM agent_group_lifecycle ORDER BY agent_group_id').all() as AgentGroupControl[];
}

export function setAgentGroupDesiredState(
  agentGroupId: string,
  desiredState: AgentGroupDesiredState,
  actor: string,
  detail?: string,
): AgentGroupControl {
  const db = getDb();
  const transition = db.transaction(() => {
    const before = ensureRow(agentGroupId);
    if (!before) throw new Error(`agent group not found: ${agentGroupId}`);
    const changed = before.desired_state !== desiredState;
    const revision = before.revision + (changed ? 1 : 0);
    const status =
      desiredState === 'paused'
        ? 'paused'
        : desiredState === 'stopped'
          ? 'stopped'
          : before.desired_state === 'running' && ['running', 'starting'].includes(before.lifecycle_status)
            ? before.lifecycle_status
            : 'idle';
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE agent_group_lifecycle
       SET desired_state = ?, lifecycle_status = ?, revision = ?, updated_at = ?, updated_by = ?, last_error = NULL
       WHERE agent_group_id = ?`,
    ).run(desiredState, status, revision, now, actor, agentGroupId);
    db.prepare(
      `INSERT INTO agent_group_lifecycle_audit
       (agent_group_id, event, from_state, to_state, revision, actor, detail, created_at)
       VALUES (?, 'desired_state', ?, ?, ?, ?, ?, ?)`,
    ).run(agentGroupId, before.desired_state, desiredState, revision, actor, detail ?? null, now);
    return db
      .prepare('SELECT * FROM agent_group_lifecycle WHERE agent_group_id = ?')
      .get(agentGroupId) as AgentGroupControl;
  });
  return transition();
}

export function canWakeAgentGroup(
  agentGroupId: string,
  _source: WakeSource,
): { allowed: boolean; reason?: string; control?: AgentGroupControl } {
  const control = getAgentGroupControl(agentGroupId);
  if (!control) return { allowed: false, reason: 'agent group not found' };
  if (control.desired_state === 'paused') return { allowed: false, reason: 'agent group is paused', control };
  return { allowed: true, control };
}

/** Atomically claim the current lifecycle revision before asynchronous spawn work begins. */
export function beginAgentGroupWake(agentGroupId: string, source: WakeSource): WakeLease | undefined {
  const db = getDb();
  const claimed = db.transaction(() => {
    const decision = canWakeAgentGroup(agentGroupId, source);
    if (!decision.allowed || !decision.control) return undefined;
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE agent_group_lifecycle
       SET lifecycle_status = 'starting', updated_at = ?, updated_by = 'wake', last_error = NULL
       WHERE agent_group_id = ? AND revision = ?`,
    ).run(now, agentGroupId, decision.control.revision);
    return { revision: decision.control.revision, source } satisfies WakeLease;
  });
  return claimed();
}

export function isAgentGroupWakeLeaseCurrent(agentGroupId: string, lease: WakeLease): boolean {
  const control = getAgentGroupControl(agentGroupId);
  return !!control && control.revision === lease.revision && control.desired_state !== 'paused';
}

export function markAgentGroupWakeSucceeded(agentGroupId: string, lease: WakeLease): boolean {
  if (!isAgentGroupWakeLeaseCurrent(agentGroupId, lease)) return false;
  const result = getDb()
    .prepare(
      `UPDATE agent_group_lifecycle
       SET lifecycle_status = 'running', updated_at = ?, updated_by = 'wake', last_error = NULL
       WHERE agent_group_id = ? AND revision = ? AND desired_state != 'paused'`,
    )
    .run(new Date().toISOString(), agentGroupId, lease.revision);
  return result.changes === 1;
}

export function markAgentGroupWakeFailed(agentGroupId: string, lease: WakeLease, error: string): boolean {
  if (!isAgentGroupWakeLeaseCurrent(agentGroupId, lease)) return false;
  const result = getDb()
    .prepare(
      `UPDATE agent_group_lifecycle
       SET lifecycle_status = 'error', updated_at = ?, updated_by = 'wake', last_error = ?
       WHERE agent_group_id = ? AND revision = ? AND desired_state != 'paused'`,
    )
    .run(new Date().toISOString(), error.slice(0, 500), agentGroupId, lease.revision);
  return result.changes === 1;
}

/** Clear a stale runtime error after an operator has successfully recovered an idle group. */
export function recoverAgentGroupLifecycle(agentGroupId: string, actor = 'host'): boolean {
  const control = getAgentGroupControl(agentGroupId);
  if (!control) return false;
  const hasRunningSession = getSessionsByAgentGroup(agentGroupId).some(
    (s) => s.status === 'active' && ['running', 'idle'].includes(s.container_status),
  );
  const status: AgentGroupLifecycleStatus =
    control.desired_state === 'paused'
      ? 'paused'
      : hasRunningSession
        ? 'running'
        : control.desired_state === 'stopped'
          ? 'stopped'
          : 'idle';
  const result = getDb()
    .prepare(
      `UPDATE agent_group_lifecycle
       SET lifecycle_status = ?, updated_at = ?, updated_by = ?, last_error = NULL
       WHERE agent_group_id = ?`,
    )
    .run(status, new Date().toISOString(), actor, agentGroupId);
  return result.changes === 1;
}

export function markAgentGroupContainerStopped(sessionId: string, error?: string): void {
  const session = getDb().prepare('SELECT agent_group_id FROM sessions WHERE id = ?').get(sessionId) as
    | { agent_group_id: string }
    | undefined;
  if (!session) return;
  const control = getAgentGroupControl(session.agent_group_id);
  if (!control) return;
  const otherRunning = getSessionsByAgentGroup(session.agent_group_id).some(
    (s) => s.id !== sessionId && s.status === 'active' && ['running', 'idle'].includes(s.container_status),
  );
  const status: AgentGroupLifecycleStatus =
    control.desired_state === 'paused'
      ? 'paused'
      : error && control.desired_state === 'running'
        ? 'error'
        : otherRunning
          ? 'running'
          : control.desired_state === 'stopped'
            ? 'stopped'
            : 'idle';
  getDb()
    .prepare(
      `UPDATE agent_group_lifecycle
       SET lifecycle_status = ?, updated_at = ?, updated_by = 'container', last_error = ?
       WHERE agent_group_id = ?`,
    )
    .run(status, new Date().toISOString(), error?.slice(0, 500) ?? null, session.agent_group_id);
}

export function isAgentGroupPaused(agentGroupId: string): boolean {
  return getAgentGroupControl(agentGroupId)?.desired_state === 'paused';
}
