/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 *
 * A task belongs to an agent group, not to the session that happened to create
 * it. Creation and execution remain session-local (so replies go back to the
 * right chat), while listing and management fan out across every session in
 * the agent group.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { insertMessage } from '../../db/session-db.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { applyTaskMutationAcrossDbs, insertTask, listTaskRows, type TaskListRow, type TaskUpdate } from './db.js';

interface TaskDb {
  sessionId: string;
  db: Database.Database;
  owned: boolean;
}

function withAgentGroupTaskDbs<T>(session: Session, currentDb: Database.Database, fn: (stores: TaskDb[]) => T): T {
  const stores: TaskDb[] = [{ sessionId: session.id, db: currentDb, owned: false }];
  const seen = new Set([session.id]);

  for (const candidate of getSessionsByAgentGroup(session.agent_group_id)) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    if (!fs.existsSync(inboundDbPath(candidate.agent_group_id, candidate.id))) {
      // A stale central session row should not prevent management of tasks in
      // the other session stores. Its DB may have been removed during cleanup.
      log.warn('Skipping missing session DB while managing tasks', {
        sessionId: candidate.id,
        agentGroupId: session.agent_group_id,
      });
      continue;
    }
    stores.push({
      sessionId: candidate.id,
      db: openInboundDb(candidate.agent_group_id, candidate.id),
      owned: true,
    });
  }

  try {
    return fn(stores);
  } finally {
    for (const store of stores) {
      if (store.owned && store.db.open) store.db.close();
    }
  }
}

function writeTaskResponse(
  inDb: Database.Database,
  requestId: string | undefined,
  ok: boolean,
  text: string,
  result: Record<string, unknown>,
): void {
  if (!requestId) return;

  insertMessage(inDb, {
    id: `sys-task-response-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'task_response', requestId, ok, text, result }),
    processAfter: null,
    recurrence: null,
    // The MCP tool polls this row directly; it must not wake the main agent
    // loop and make the response appear as an unsolicited user message.
    trigger: 0,
  });
}

function requestIdFrom(content: Record<string, unknown>): string | undefined {
  return typeof content.requestId === 'string' ? content.requestId : undefined;
}

function taskMutationResponse(
  inDb: Database.Database,
  requestId: string | undefined,
  action: string,
  taskId: string,
  touched: number,
): void {
  const ok = touched > 0;
  const noun = touched === 1 ? 'occurrence' : 'occurrences';
  const text = ok
    ? `Task ${action}: ${taskId} (${touched} live ${noun} changed).`
    : `No live task matched id "${taskId}".`;
  writeTaskResponse(inDb, requestId, ok, text, { affected: touched });
  if (ok) {
    log.info(`Task ${action}`, { taskId, touched });
  } else {
    log.warn(`Task ${action} matched no live task`, { taskId });
  }
}

function formatTaskRow(row: TaskListRow): string {
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(row.content) as Record<string, unknown>;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // Keep listing usable even if a legacy task has malformed content.
  }

  const prompt = (typeof content.prompt === 'string' ? content.prompt : '').slice(0, 80);
  const plane = content.delegateTo === 'errand-runner' ? 'plane=errand-runner ' : '';
  const destination =
    row.channel_type && row.platform_id
      ? `${row.channel_type}:${row.platform_id}${row.thread_id ? `#${row.thread_id}` : ''}`
      : `session:${row.sessionId}`;
  return `- ${row.id} [${row.status}] at=${row.process_after || 'now'} ${row.recurrence ? `recur=${row.recurrence} ` : ''}${plane}session=${row.sessionId} destination=${destination}→ ${prompt}`;
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const delegateTo = content.delegateTo === 'errand-runner' ? 'errand-runner' : null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  insertTask(inDb, {
    id: taskId,
    processAfter,
    recurrence,
    platformId: (content.platformId as string) ?? null,
    channelType: (content.channelType as string) ?? null,
    threadId: (content.threadId as string) ?? null,
    content: JSON.stringify({ prompt, script, ...(delegateTo ? { delegateTo } : {}) }),
  });
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
  writeTaskResponse(
    inDb,
    requestIdFrom(content),
    true,
    `Task scheduled (id: ${taskId}, runs at: ${processAfter}${recurrence ? `, recurrence: ${recurrence}` : ''}${delegateTo ? `, execution plane: ${delegateTo}` : ''})`,
    { taskId },
  );
}

export async function handleListTasks(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const status = typeof content.status === 'string' ? content.status : undefined;
  const rows = withAgentGroupTaskDbs(session, inDb, (stores) =>
    stores.flatMap((store) => listTaskRows(store.db, { sessionId: store.sessionId }, status)),
  ).sort((a, b) => (a.process_after ?? '').localeCompare(b.process_after ?? ''));
  const text = rows.length === 0 ? 'No tasks found.' : rows.map(formatTaskRow).join('\n');
  writeTaskResponse(inDb, requestIdFrom(content), true, text, { tasks: rows });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const touched = withAgentGroupTaskDbs(session, inDb, (stores) =>
    applyTaskMutationAcrossDbs(
      stores.map((store) => store.db),
      taskId,
      { kind: 'cancel' },
    ),
  );
  taskMutationResponse(inDb, requestIdFrom(content), 'cancelled', taskId, touched);
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const touched = withAgentGroupTaskDbs(session, inDb, (stores) =>
    applyTaskMutationAcrossDbs(
      stores.map((store) => store.db),
      taskId,
      { kind: 'pause' },
    ),
  );
  taskMutationResponse(inDb, requestIdFrom(content), 'paused', taskId, touched);
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const touched = withAgentGroupTaskDbs(session, inDb, (stores) =>
    applyTaskMutationAcrossDbs(
      stores.map((store) => store.db),
      taskId,
      { kind: 'resume' },
    ),
  );
  taskMutationResponse(inDb, requestIdFrom(content), 'resumed', taskId, touched);
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  if (content.delegateTo === null || content.delegateTo === 'jeeves' || content.delegateTo === 'errand-runner') {
    update.delegateTo = content.delegateTo as 'jeeves' | 'errand-runner' | null;
  }

  const touched = withAgentGroupTaskDbs(session, inDb, (stores) =>
    applyTaskMutationAcrossDbs(
      stores.map((store) => store.db),
      taskId,
      { kind: 'update', update },
    ),
  );
  taskMutationResponse(inDb, requestIdFrom(content), 'updated', taskId, touched);
}
