import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { PATHS } from '../config.js';
import type { AgentGroupInfo } from './central.js';
import { readLogEvents, type StructuredLogEvent } from './logs.js';
import { readMemoryDb, type MemoryDbSnapshot } from './memory.js';
import { senderOf, toIsoUtc } from './sessiondbs.js';
import { inspectSqliteDb, listSqliteFiles, type SqliteDbInventory } from './sqlite-inventory.js';

export interface GroundingEvent {
  sessionId: string;
  createdAt: string;
  completedAt: string | null;
  coreOk: boolean;
  memoryOk: boolean;
  memoryCountBefore: number;
  memoryCountAfter: number | null;
  rememberRequested: boolean;
  rememberSatisfied: boolean | null;
  errors: string[];
}

export interface TripOperationalEvent {
  ts: string;
  source: 'log' | 'inbound' | 'outbound' | 'grounding';
  category: string;
  level: string;
  sessionId: string | null;
  channel: string | null;
  actor: string | null;
  summary: string;
  snippet: string | null;
}

export interface WorkflowSummary {
  available: boolean;
  total: number;
  byStatus: Record<string, number>;
  pendingDrafts: number;
  failedActions: number;
  nextTimer: string | null;
  error: string | null;
}

export interface TripHostMember {
  userId: string;
  displayName: string | null;
  channel: string;
}

export interface TripHostWire {
  id: string;
  channel: string | null;
  instance: string | null;
  name: string | null;
  platformId: string | null;
  engageMode: string;
  senderScope: string;
  ignoredMessagePolicy: string;
  sessionMode: string;
  hasDestination: boolean;
}

export interface TripHostSession {
  id: string;
  status: string;
  containerStatus: string;
  lastActive: string | null;
  lastInbound: string | null;
  lastOutbound: string | null;
  heartbeatAgeMs: number | null;
  pendingMessages: number;
  processingClaims: number;
}

export interface TripHostStatus {
  available: boolean;
  model: string | null;
  provider: string | null;
  desiredState: string | null;
  lifecycleStatus: string | null;
  lifecycleError: string | null;
  members: TripHostMember[];
  wires: TripHostWire[];
  sessions: TripHostSession[];
  activeSessions: number;
  lastActivity: string | null;
}

export interface TripCompanionSnapshot {
  id: string;
  name: string;
  folder: string;
  core: {
    available: boolean;
    configured: boolean;
    name: string | null;
    stage: string | null;
    status: string | null;
    activeMembers: number;
    families: number;
    openDecisions: number;
    openNotes: number;
    error: string | null;
  };
  host: TripHostStatus;
  memory: MemoryDbSnapshot;
  grounding: GroundingEvent[];
  workflows: WorkflowSummary;
  databases: SqliteDbInventory[];
  operations: TripOperationalEvent[];
  warnings: string[];
}

function openReadonly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');
  return db;
}

function emptyHost(): TripHostStatus {
  return {
    available: false,
    model: null,
    provider: null,
    desiredState: null,
    lifecycleStatus: null,
    lifecycleError: null,
    members: [],
    wires: [],
    sessions: [],
    activeSessions: 0,
    lastActivity: null,
  };
}

function tableExistsIn(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

function readSessionHostStatus(sessionId: string, sessionsDir: string, row: {
  status: string;
  container_status: string;
  last_active: string | null;
}): TripHostSession {
  const sessionDir = path.join(sessionsDir, sessionId);
  const inboundFile = path.join(sessionDir, 'inbound.db');
  const outboundFile = path.join(sessionDir, 'outbound.db');
  let lastInbound: string | null = null;
  let lastOutbound: string | null = null;
  let pendingMessages = 0;
  let processingClaims = 0;
  const readMessageDb = (file: string, direction: 'inbound' | 'outbound') => {
    if (!fs.existsSync(file)) return;
    let db: Database.Database | null = null;
    try {
      db = openReadonly(file);
      if (direction === 'inbound' && tableExistsIn(db, 'messages_in')) {
        const latest = db.prepare('SELECT MAX(timestamp) AS ts FROM messages_in WHERE kind != \'task\'').get() as { ts: string | null };
        lastInbound = latest.ts ?? null;
        pendingMessages = Number((db.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE status = 'pending' AND kind != 'system'").get() as { n: number }).n ?? 0);
      }
      if (direction === 'outbound' && tableExistsIn(db, 'messages_out')) {
        const latest = db.prepare('SELECT MAX(timestamp) AS ts FROM messages_out').get() as { ts: string | null };
        lastOutbound = latest.ts ?? null;
        if (tableExistsIn(db, 'processing_ack')) {
          processingClaims = Number((db.prepare("SELECT COUNT(*) AS n FROM processing_ack WHERE status = 'processing'").get() as { n: number }).n ?? 0);
        }
      }
    } catch {
      // A session may be mid-write or from an older schema.
    } finally {
      db?.close();
    }
  };
  readMessageDb(inboundFile, 'inbound');
  readMessageDb(outboundFile, 'outbound');
  let heartbeatAgeMs: number | null = null;
  const heartbeat = path.join(sessionDir, '.heartbeat');
  try {
    if (fs.existsSync(heartbeat)) heartbeatAgeMs = Math.max(0, Date.now() - fs.statSync(heartbeat).mtimeMs);
  } catch {
    // Best-effort only.
  }
  return {
    id: sessionId,
    status: row.status,
    containerStatus: row.container_status,
    lastActive: row.last_active,
    lastInbound,
    lastOutbound,
    heartbeatAgeMs,
    pendingMessages,
    processingClaims,
  };
}

function readHostStatus(group: AgentGroupInfo, sessionsDir: string, centralDb: string): TripHostStatus {
  if (!fs.existsSync(centralDb)) return emptyHost();
  let db: Database.Database | null = null;
  try {
    db = openReadonly(centralDb);
    const host = emptyHost();
    host.available = true;
    if (tableExistsIn(db, 'container_configs')) {
      const config = db.prepare('SELECT model, provider FROM container_configs WHERE agent_group_id = ?').get(group.id) as
        | { model: string | null; provider: string | null }
        | undefined;
      host.model = config?.model ?? group.model;
      host.provider = config?.provider ?? group.provider;
    } else {
      host.model = group.model;
      host.provider = group.provider;
    }
    if (tableExistsIn(db, 'agent_group_lifecycle')) {
      const lifecycle = db.prepare(
        'SELECT desired_state, lifecycle_status, last_error FROM agent_group_lifecycle WHERE agent_group_id = ?',
      ).get(group.id) as { desired_state: string; lifecycle_status: string; last_error: string | null } | undefined;
      host.desiredState = lifecycle?.desired_state ?? group.desired_state ?? 'running';
      host.lifecycleStatus = lifecycle?.lifecycle_status ?? group.lifecycle_status ?? 'idle';
      host.lifecycleError = lifecycle?.last_error ?? group.lifecycle_error ?? null;
    } else {
      host.desiredState = group.desired_state ?? 'running';
      host.lifecycleStatus = group.lifecycle_status ?? 'idle';
      host.lifecycleError = group.lifecycle_error ?? null;
    }
    if (tableExistsIn(db, 'agent_group_members')) {
      host.members = (db.prepare(
        `SELECT m.user_id, u.display_name FROM agent_group_members m
         LEFT JOIN users u ON u.id = m.user_id WHERE m.agent_group_id = ? ORDER BY u.display_name, m.user_id`,
      ).all(group.id) as Array<{ user_id: string; display_name: string | null }>).map((member) => {
        const colon = member.user_id.indexOf(':');
        return {
          userId: member.user_id,
          displayName: member.display_name,
          channel: colon > 0 ? member.user_id.slice(0, colon) : 'unknown',
        };
      });
    }
    if (tableExistsIn(db, 'messaging_group_agents') && tableExistsIn(db, 'messaging_groups')) {
      const wires = db.prepare(
        `SELECT a.id, m.channel_type, m.instance, m.name, m.platform_id,
                a.engage_mode, a.sender_scope, a.ignored_message_policy, a.session_mode,
                EXISTS(SELECT 1 FROM agent_destinations d
                       WHERE d.agent_group_id = a.agent_group_id AND d.target_type = 'channel'
                         AND d.target_id = a.messaging_group_id) AS has_destination
         FROM messaging_group_agents a JOIN messaging_groups m ON m.id = a.messaging_group_id
         WHERE a.agent_group_id = ? ORDER BY a.created_at`,
      ).all(group.id) as Array<{
        id: string;
        channel_type: string | null;
        instance: string | null;
        name: string | null;
        platform_id: string | null;
        engage_mode: string;
        sender_scope: string;
        ignored_message_policy: string;
        session_mode: string;
        has_destination: number;
      }>;
      host.wires = wires.map((wire) => ({
        id: wire.id,
        channel: wire.channel_type,
        instance: wire.instance,
        name: wire.name,
        platformId: wire.platform_id,
        engageMode: wire.engage_mode,
        senderScope: wire.sender_scope,
        ignoredMessagePolicy: wire.ignored_message_policy,
        sessionMode: wire.session_mode,
        hasDestination: wire.has_destination === 1,
      }));
    }
    if (tableExistsIn(db, 'sessions')) {
      const sessions = db.prepare(
        'SELECT id, status, container_status, last_active FROM sessions WHERE agent_group_id = ? ORDER BY last_active DESC, created_at DESC',
      ).all(group.id) as Array<{ id: string; status: string; container_status: string; last_active: string | null }>;
      host.sessions = sessions.map((session) => readSessionHostStatus(session.id, sessionsDir, session));
    }
    host.activeSessions = host.sessions.filter(
      (session) => session.status === 'active' && ['running', 'idle'].includes(session.containerStatus),
    ).length;
    host.lastActivity = host.sessions
      .flatMap((session) => [session.lastActive, session.lastInbound, session.lastOutbound])
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    return host;
  } catch (error) {
    return { ...emptyHost(), available: true, lifecycleError: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

function count(db: Database.Database, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
}

function readCore(file: string): TripCompanionSnapshot['core'] {
  const empty = {
    available: false,
    configured: false,
    name: null,
    stage: null,
    status: null,
    activeMembers: 0,
    families: 0,
    openDecisions: 0,
    openNotes: 0,
    error: null,
  };
  if (!fs.existsSync(file)) return empty;
  let db: Database.Database | null = null;
  try {
    db = openReadonly(file);
    const trip = tableExists(db, 'trip')
      ? (db.prepare('SELECT name, stage, status FROM trip WHERE id = 1').get() as
          | { name: string; stage: string; status: string }
          | undefined)
      : undefined;
    return {
      available: true,
      configured: trip != null,
      name: trip?.name ?? null,
      stage: trip?.stage ?? null,
      status: trip?.status ?? null,
      activeMembers: tableExists(db, 'members')
        ? count(db, 'SELECT COUNT(*) AS n FROM members WHERE left_at IS NULL AND excluded_from_splits = 0')
        : 0,
      families: tableExists(db, 'families') ? count(db, 'SELECT COUNT(*) AS n FROM families') : 0,
      openDecisions: tableExists(db, 'decisions')
        ? count(db, "SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'")
        : 0,
      openNotes: tableExists(db, 'scratchpad')
        ? count(db, "SELECT COUNT(*) AS n FROM scratchpad WHERE status = 'open'")
        : 0,
      error: null,
    };
  } catch (error) {
    return { ...empty, available: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function readWorkflows(file: string): WorkflowSummary {
  const empty: WorkflowSummary = {
    available: false,
    total: 0,
    byStatus: {},
    pendingDrafts: 0,
    failedActions: 0,
    nextTimer: null,
    error: null,
  };
  if (!fs.existsSync(file)) return empty;
  let db: Database.Database | null = null;
  try {
    db = openReadonly(file);
    if (!tableExists(db, 'workflow_instances')) {
      return { ...empty, available: true, error: 'workflow_instances table missing' };
    }
    const counts = db.prepare('SELECT status, COUNT(*) AS n FROM workflow_instances GROUP BY status').all() as Array<{
      status: string;
      n: number;
    }>;
    const byStatus = Object.fromEntries(counts.map((row) => [row.status, Number(row.n)]));
    const pendingDrafts = tableExists(db, 'workflow_actions')
      ? count(db, "SELECT COUNT(*) AS n FROM workflow_actions WHERE action_type = 'create_gmail_draft' AND review_status IN ('review_pending', 'approved')")
      : 0;
    const failedActions = tableExists(db, 'workflow_actions')
      ? count(db, "SELECT COUNT(*) AS n FROM workflow_actions WHERE status = 'failed'")
      : 0;
    const nextTimer = tableExists(db, 'workflow_timers')
      ? ((db.prepare("SELECT MIN(due_at) AS due_at FROM workflow_timers WHERE status = 'scheduled'").get() as {
          due_at: string | null;
        })?.due_at ?? null)
      : null;
    return {
      available: true,
      total: counts.reduce((sum, row) => sum + Number(row.n), 0),
      byStatus,
      pendingDrafts,
      failedActions,
      nextTimer,
      error: null,
    };
  } catch (error) {
    return { ...empty, available: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function messageSummary(content: string, showSnippet: boolean): { summary: string; snippet: string | null } {
  try {
    const parsed = JSON.parse(content);
    const text = parsed.text ?? parsed.prompt ?? parsed.content ?? parsed.message ?? parsed.body;
    if (typeof text === 'string' && text.trim()) {
      const clean = text.replace(/\s+/g, ' ').trim();
      return {
        summary: clean.slice(0, 120),
        snippet: showSnippet ? clean.slice(0, 220) : null,
      };
    }
    const keys = Object.keys(parsed).slice(0, 5);
    return {
      summary: keys.length ? `json: ${keys.join(', ')}` : 'json message',
      snippet: showSnippet ? content.slice(0, 220) : null,
    };
  } catch {
    const clean = content.replace(/\s+/g, ' ').trim();
    return { summary: clean.slice(0, 120), snippet: showSnippet ? clean.slice(0, 220) : null };
  }
}

function readSessionOperations(
  groupId: string,
  sessionsDir: string,
  showSnippet: boolean,
  perSessionLimit = 12,
): TripOperationalEvent[] {
  const groupDir = path.join(sessionsDir, groupId);
  if (!fs.existsSync(groupDir)) return [];
  const events: TripOperationalEvent[] = [];
  for (const sessionId of fs.readdirSync(groupDir)) {
    const sessionDir = path.join(groupDir, sessionId);
    if (!fs.statSync(sessionDir).isDirectory()) continue;
    const inboundFile = path.join(sessionDir, 'inbound.db');
    if (fs.existsSync(inboundFile)) {
      let db: Database.Database | null = null;
      try {
        db = openReadonly(inboundFile);
        if (tableExists(db, 'messages_in')) {
          const rows = db
            .prepare(
              `SELECT id, timestamp, kind, status, trigger, channel_type, content
               FROM messages_in
               WHERE kind != 'task'
               ORDER BY timestamp DESC LIMIT ?`,
            )
            .all(perSessionLimit) as {
            id: string;
            timestamp: string;
            kind: string;
            status: string | null;
            trigger: number | null;
            channel_type: string | null;
            content: string;
          }[];
          for (const row of rows) {
            const sender = senderOf(row.content);
            const summary = messageSummary(row.content, showSnippet);
            events.push({
              ts: row.timestamp,
              source: 'inbound',
              category: row.trigger ? 'message' : 'context',
              level: row.status === 'failed' ? 'error' : row.status === 'pending' ? 'warn' : 'info',
              sessionId,
              channel: row.channel_type,
              actor: sender?.name ?? null,
              summary: showSnippet
                ? `${row.kind} ${row.status ?? 'unknown'}`
                : `${row.kind} ${row.status ?? 'unknown'} · content hidden`,
              snippet: summary.snippet,
            });
          }
        }
      } catch {
        // Old or locked session DBs should not hide the rest of the trip view.
      } finally {
        db?.close();
      }
    }

    const outboundFile = path.join(sessionDir, 'outbound.db');
    if (fs.existsSync(outboundFile)) {
      let db: Database.Database | null = null;
      try {
        db = openReadonly(outboundFile);
        if (tableExists(db, 'messages_out')) {
          const rows = db
            .prepare(
              `SELECT id, timestamp, kind, channel_type, content
               FROM messages_out
               ORDER BY timestamp DESC LIMIT ?`,
            )
            .all(perSessionLimit) as {
            id: string;
            timestamp: string;
            kind: string;
            channel_type: string | null;
            content: string;
          }[];
          for (const row of rows) {
            const summary = messageSummary(row.content, showSnippet);
            events.push({
              ts: toIsoUtc(row.timestamp),
              source: 'outbound',
              category: 'response',
              level: 'info',
              sessionId,
              channel: row.channel_type,
              actor: 'agent',
              summary: showSnippet
                ? `${row.kind} queued for delivery`
                : `${row.kind} queued for delivery · content hidden`,
              snippet: summary.snippet,
            });
          }
        }
      } catch {
        // Best-effort only.
      } finally {
        db?.close();
      }
    }
  }
  return events;
}

function logOperations(group: AgentGroupInfo, injected?: StructuredLogEvent[]): TripOperationalEvent[] {
  const events = injected ?? readLogEvents({ groupId: group.id, limit: 120 });
  return events
    .filter((event) => event.groupId === group.id || event.line.includes(group.id) || event.line.includes(group.folder))
    .slice(0, 40)
    .map((event) => ({
      ts: event.clock ?? '',
      source: 'log' as const,
      category: event.category,
      level: event.level,
      sessionId: event.sessionId,
      channel: null,
      actor: null,
      summary: event.message,
      snippet: event.line.slice(0, 260),
    }));
}

function groundingOperations(events: GroundingEvent[]): TripOperationalEvent[] {
  return events.slice(0, 20).map((event) => ({
    ts: event.createdAt,
    source: 'grounding' as const,
    category: 'grounding',
    level: event.coreOk && event.memoryOk ? 'info' : 'error',
    sessionId: event.sessionId,
    channel: null,
    actor: 'agent-runner',
    summary:
      event.coreOk && event.memoryOk
        ? `grounding passed · memory ${event.memoryCountBefore} to ${event.memoryCountAfter ?? event.memoryCountBefore}`
        : `grounding failed · ${event.errors.join('; ') || 'unknown error'}`,
    snippet: event.rememberRequested
      ? `remember request ${event.rememberSatisfied ? 'saved' : event.rememberSatisfied === false ? 'not saved' : 'pending'}`
      : null,
  }));
}

function readDatabaseInventory(group: AgentGroupInfo, groupsDir: string, sessionsDir: string): SqliteDbInventory[] {
  const groupDir = path.join(groupsDir, group.folder);
  const files: { file: string; label: string; scope: string }[] = [];
  for (const file of listSqliteFiles(groupDir)) {
    files.push({ file, label: `groups/${group.folder}/${path.basename(file)}`, scope: 'group' });
  }
  const sessionRoot = path.join(sessionsDir, group.id);
  if (fs.existsSync(sessionRoot)) {
    for (const sessionId of fs.readdirSync(sessionRoot)) {
      const sessionDir = path.join(sessionRoot, sessionId);
      if (!fs.statSync(sessionDir).isDirectory()) continue;
      for (const name of ['inbound.db', 'outbound.db']) {
        const file = path.join(sessionDir, name);
        if (fs.existsSync(file)) files.push({ file, label: `sessions/${sessionId}/${name}`, scope: 'session' });
      }
    }
  }
  const seen = new Set<string>();
  return files
    .filter(({ file }) => {
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    })
    .map(({ file, label, scope }) => inspectSqliteDb(file, { label, scope }));
}

function readGrounding(groupId: string, sessionsDir: string): GroundingEvent[] {
  const groupDir = path.join(sessionsDir, groupId);
  if (!fs.existsSync(groupDir)) return [];
  const events: GroundingEvent[] = [];
  for (const sessionId of fs.readdirSync(groupDir)) {
    const file = path.join(groupDir, sessionId, 'outbound.db');
    if (!fs.existsSync(file)) continue;
    let db: Database.Database | null = null;
    try {
      db = openReadonly(file);
      if (!tableExists(db, 'grounding_events')) continue;
      const rows = db
        .prepare(
          `SELECT created_at, completed_at, core_ok, memory_ok, errors_json,
                  remember_requested, remember_satisfied, memory_count_before, memory_count_after
           FROM grounding_events ORDER BY id DESC LIMIT 30`,
        )
        .all() as Array<{
        created_at: string;
        completed_at: string | null;
        core_ok: number;
        memory_ok: number;
        errors_json: string;
        remember_requested: number;
        remember_satisfied: number | null;
        memory_count_before: number;
        memory_count_after: number | null;
      }>;
      events.push(
        ...rows.map((row) => ({
          sessionId,
          createdAt: row.created_at,
          completedAt: row.completed_at,
          coreOk: row.core_ok === 1,
          memoryOk: row.memory_ok === 1,
          memoryCountBefore: row.memory_count_before,
          memoryCountAfter: row.memory_count_after,
          rememberRequested: row.remember_requested === 1,
          rememberSatisfied: row.remember_satisfied == null ? null : row.remember_satisfied === 1,
          errors: parseJsonArray(row.errors_json),
        })),
      );
    } catch {
      // A session may be mid-write or from an older schema. Other sessions
      // still provide useful evidence, so treat this as best-effort.
    } finally {
      db?.close();
    }
  }
  return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
}

export function readTripCompanions(
  groups: AgentGroupInfo[],
  opts: {
    groupsDir?: string;
    sessionsDir?: string;
    centralDb?: string;
    showMessageSnippets?: boolean;
    logEvents?: StructuredLogEvent[];
  } = {},
): TripCompanionSnapshot[] {
  const groupsDir = opts.groupsDir ?? PATHS.groupsDir;
  const sessionsDir = opts.sessionsDir ?? PATHS.sessionsDir;
  const centralDb = opts.centralDb ?? PATHS.centralDb;
  const showMessageSnippets = opts.showMessageSnippets ?? true;
  const snapshots: TripCompanionSnapshot[] = [];
  for (const group of groups) {
    const dir = path.join(groupsDir, group.folder);
    const tripDb = path.join(dir, 'trip.db');
    const memoryDb = path.join(dir, 'memory.db');
    const workflowsDb = path.join(dir, 'workflows.db');
    // A generic agent may have memory.db too. trip.db is the marker that this
    // workspace participates in the Trip Companion domain.
    if (!fs.existsSync(tripDb)) continue;
    const core = readCore(tripDb);
    const host = readHostStatus(group, sessionsDir, centralDb);
    const memory = readMemoryDb(memoryDb);
    const workflows = readWorkflows(workflowsDb);
    const grounding = readGrounding(group.id, sessionsDir);
    const databases = readDatabaseInventory(group, groupsDir, sessionsDir);
    const operations = [
      ...logOperations(group, opts.logEvents),
      ...readSessionOperations(group.id, sessionsDir, showMessageSnippets),
      ...groundingOperations(grounding),
    ]
      .filter((event) => event.ts)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, 80);
    const warnings: string[] = [];
    if (core.error) warnings.push(`core unreadable: ${core.error}`);
    if (memory.error) warnings.push(`memory unreadable: ${memory.error}`);
    if (workflows.error) warnings.push(`workflows unreadable: ${workflows.error}`);
    if (workflows.failedActions > 0) warnings.push(`${workflows.failedActions} workflow action(s) failed`);
    if (core.available && !core.configured) warnings.push('trip-core has tables but no configured trip row');
    if (core.activeMembers > 0 && !core.configured) warnings.push('roster exists before trip-core setup is complete');
    const latest = grounding[0];
    if (!latest) warnings.push('no runner grounding evidence yet');
    else {
      if (!latest.coreOk || !latest.memoryOk) warnings.push('latest grounding snapshot failed');
      if (latest.rememberRequested && latest.rememberSatisfied === false)
        warnings.push('latest explicit remember request produced no new active memory');
    }
    snapshots.push({
      id: group.id,
      name: group.name,
      folder: group.folder,
      core,
      host,
      memory,
      grounding,
      workflows,
      databases,
      operations,
      warnings,
    });
  }
  return snapshots.sort((a, b) => a.name.localeCompare(b.name));
}
