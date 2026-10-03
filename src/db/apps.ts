import { getDb, hasTable } from './connection.js';
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
} from '../modules/agent-to-agent/db/agent-destinations.js';
import { projectDestinationsToSessions } from '../modules/agent-to-agent/destination-projection.js';

export type AppKind = 'agent' | 'service';
export type AppReadSource = 'ops-center:/trips' | 'ops-center' | 'a2a' | 'none';
export type AppVisibility = 'private' | 'shared';
export type AppStatus = 'active' | 'retired';

export interface AppCatalogEntry {
  handle: string;
  name: string;
  kind: AppKind;
  type: string;
  agent_group_id: string | null;
  purpose: string;
  read_source: AppReadSource;
  visibility: AppVisibility;
  status: AppStatus;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

export interface CreateAppInput {
  handle: string;
  name: string;
  kind: AppKind;
  type: string;
  agent_group_id?: string | null;
  purpose: string;
  read_source?: AppReadSource;
  visibility?: AppVisibility;
}

export interface UpdateAppInput {
  name?: string;
  type?: string;
  agent_group_id?: string | null;
  purpose?: string;
  read_source?: AppReadSource;
  visibility?: AppVisibility;
}

const RESERVED_HANDLES = new Set(['jeeves', 'ops']);
const VALID_READ_SOURCES = new Set<AppReadSource>(['ops-center:/trips', 'ops-center', 'a2a', 'none']);
const VALID_VISIBILITIES = new Set<AppVisibility>(['private', 'shared']);
const VALID_KINDS = new Set<AppKind>(['agent', 'service']);

export function normalizeAppHandle(input: string): string {
  return input.trim().replace(/^@+/, '').toLowerCase();
}

export function validateAppHandle(input: string): string {
  const handle = normalizeAppHandle(input);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(handle)) {
    throw new Error('--handle must be kebab-case using lowercase letters, numbers, and dashes');
  }
  if (handle.includes('--')) throw new Error('--handle cannot contain consecutive dashes');
  if (RESERVED_HANDLES.has(handle)) throw new Error(`@${handle} is reserved`);
  return handle;
}

export function createApp(input: CreateAppInput): AppCatalogEntry {
  const handle = validateAppHandle(input.handle);
  const now = new Date().toISOString();
  const row = {
    handle,
    name: required(input.name, '--name'),
    kind: validateEnum(input.kind, VALID_KINDS, '--kind'),
    type: required(input.type, '--type'),
    agent_group_id: input.agent_group_id ?? null,
    purpose: required(input.purpose, '--purpose'),
    read_source: validateEnum(input.read_source ?? 'a2a', VALID_READ_SOURCES, '--read-source'),
    visibility: validateEnum(input.visibility ?? 'private', VALID_VISIBILITIES, '--visibility'),
    status: 'active' as AppStatus,
    created_at: now,
    updated_at: now,
    retired_at: null,
  };
  if (row.kind === 'agent' && !row.agent_group_id) throw new Error('--agent-group-id is required when --kind agent');
  if (row.kind === 'service' && row.agent_group_id) throw new Error('--agent-group-id is only valid when --kind agent');

  getDb()
    .prepare(
      `INSERT INTO apps (
         handle, name, kind, type, agent_group_id, purpose, read_source, visibility,
         status, created_at, updated_at, retired_at
       )
       VALUES (
         @handle, @name, @kind, @type, @agent_group_id, @purpose, @read_source, @visibility,
         @status, @created_at, @updated_at, @retired_at
       )`,
    )
    .run(row);
  return row;
}

export function updateApp(
  handleInput: string,
  input: UpdateAppInput,
): { before: AppCatalogEntry; after: AppCatalogEntry } {
  const handle = normalizeAppHandle(handleInput);
  const before = getApp(handle);
  if (!before) throw new Error(`app not found: @${handle}`);
  if (before.status === 'retired') throw new Error(`app is retired: @${handle}`);

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = required(input.name, '--name');
  if (input.type !== undefined) updates.type = required(input.type, '--type');
  if (input.agent_group_id !== undefined) updates.agent_group_id = input.agent_group_id || null;
  if (input.purpose !== undefined) updates.purpose = required(input.purpose, '--purpose');
  if (input.read_source !== undefined)
    updates.read_source = validateEnum(input.read_source, VALID_READ_SOURCES, '--read-source');
  if (input.visibility !== undefined)
    updates.visibility = validateEnum(input.visibility, VALID_VISIBILITIES, '--visibility');
  if (Object.keys(updates).length === 0) {
    throw new Error(
      'nothing to update — provide one of: --name, --type, --agent-group-id, --purpose, --read-source, --visibility',
    );
  }
  if (
    before.kind === 'agent' &&
    Object.prototype.hasOwnProperty.call(updates, 'agent_group_id') &&
    !updates.agent_group_id
  ) {
    throw new Error('--agent-group-id cannot be cleared for agent apps');
  }
  updates.updated_at = new Date().toISOString();
  const set = Object.keys(updates)
    .map((key) => `${key} = @${key}`)
    .join(', ');
  getDb()
    .prepare(`UPDATE apps SET ${set} WHERE handle = @handle`)
    .run({ ...updates, handle });
  const after = getApp(handle);
  if (!after) throw new Error(`app not found after update: @${handle}`);
  return { before, after };
}

export function retireApp(handleInput: string): AppCatalogEntry {
  const handle = normalizeAppHandle(handleInput);
  const existing = getApp(handle);
  if (!existing) throw new Error(`app not found: @${handle}`);
  if (existing.status === 'retired') return existing;
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE apps SET status = 'retired', retired_at = ?, updated_at = ? WHERE handle = ?")
    .run(now, now, handle);
  return getApp(handle)!;
}

export function getApp(handleInput: string): AppCatalogEntry | undefined {
  const handle = normalizeAppHandle(handleInput);
  return getDb().prepare('SELECT * FROM apps WHERE handle = ?').get(handle) as AppCatalogEntry | undefined;
}

export function listApps(
  filters: Partial<Pick<AppCatalogEntry, 'kind' | 'type' | 'visibility' | 'status'>> = {},
): AppCatalogEntry[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const key of ['kind', 'type', 'visibility', 'status'] as const) {
    if (filters[key] !== undefined) {
      clauses.push(`${key} = ?`);
      params.push(filters[key]);
    }
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM apps${where} ORDER BY status, type, handle`)
    .all(...params) as AppCatalogEntry[];
}

export function resolveSupervisorAgentGroupId(explicitId?: string): string {
  if (explicitId) {
    const row = getDb().prepare('SELECT id FROM agent_groups WHERE id = ?').get(explicitId);
    if (!row) throw new Error(`supervisor agent group not found: ${explicitId}`);
    return explicitId;
  }

  const named = getDb()
    .prepare(
      `SELECT id, name, folder
       FROM agent_groups
       WHERE lower(name) = 'jeeves' OR lower(folder) = 'jeeves'
          OR lower(name) LIKE '%jeeves%' OR lower(folder) LIKE '%jeeves%'
       ORDER BY CASE
         WHEN lower(name) = 'jeeves' OR lower(folder) = 'jeeves' THEN 0
         ELSE 1
       END, created_at`,
    )
    .all() as Array<{ id: string; name: string; folder: string }>;
  if (named.length === 1) return named[0].id;
  if (named.length > 1) throw new Error('multiple Jeeves-like groups found; pass --supervisor-agent-group-id');

  const globals = getDb()
    .prepare(
      `SELECT g.id
       FROM agent_groups g
       JOIN container_configs c ON c.agent_group_id = g.id
       WHERE c.cli_scope = 'global'
       ORDER BY g.created_at`,
    )
    .all() as Array<{ id: string }>;
  if (globals.length === 1) return globals[0].id;
  throw new Error('could not infer Jeeves; pass --supervisor-agent-group-id');
}

export async function projectAppDestinations(app: AppCatalogEntry, supervisorAgentGroupId: string): Promise<void> {
  if (app.status !== 'active' || app.kind !== 'agent' || !app.agent_group_id) return;
  if (!hasTable(getDb(), 'agent_destinations')) return;
  assertAgentGroupExists(app.agent_group_id, '--agent-group-id');
  assertAgentGroupExists(supervisorAgentGroupId, '--supervisor-agent-group-id');
  ensureDestination(supervisorAgentGroupId, app.handle, 'agent', app.agent_group_id);
  ensureDestination(app.agent_group_id, 'jeeves', 'agent', supervisorAgentGroupId);
  await projectDestinationsToSessions(supervisorAgentGroupId);
  await projectDestinationsToSessions(app.agent_group_id);
}

export async function unprojectAppDestinations(app: AppCatalogEntry, supervisorAgentGroupId: string): Promise<void> {
  if (app.kind !== 'agent' || !app.agent_group_id || !hasTable(getDb(), 'agent_destinations')) return;
  removeDestinationIfMatches(supervisorAgentGroupId, app.handle, 'agent', app.agent_group_id);
  if (!hasOtherActiveAppForAgentGroup(app.handle, app.agent_group_id)) {
    removeDestinationIfMatches(app.agent_group_id, 'jeeves', 'agent', supervisorAgentGroupId);
    await projectDestinationsToSessions(app.agent_group_id);
  }
  await projectDestinationsToSessions(supervisorAgentGroupId);
}

function ensureDestination(
  agentGroupId: string,
  localName: string,
  targetType: 'channel' | 'agent',
  targetId: string,
): void {
  const existing = getDestinationByName(agentGroupId, localName);
  if (existing) {
    if (existing.target_type === targetType && existing.target_id === targetId) return;
    throw new Error(
      `destination "${localName}" already exists for ${agentGroupId} and points at ${existing.target_type}:${existing.target_id}`,
    );
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: localName,
    target_type: targetType,
    target_id: targetId,
    created_at: new Date().toISOString(),
  });
}

function removeDestinationIfMatches(
  agentGroupId: string,
  localName: string,
  targetType: 'channel' | 'agent',
  targetId: string,
): void {
  const existing = getDestinationByName(agentGroupId, localName);
  if (!existing) return;
  if (existing.target_type !== targetType || existing.target_id !== targetId) return;
  deleteDestination(agentGroupId, localName);
}

function hasOtherActiveAppForAgentGroup(handle: string, agentGroupId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 FROM apps WHERE handle != ? AND agent_group_id = ? AND kind = 'agent' AND status = 'active' LIMIT 1",
    )
    .get(handle, agentGroupId);
  return !!row;
}

function assertAgentGroupExists(id: string, argName: string): void {
  const row = getDb().prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(id);
  if (!row) throw new Error(`${argName} not found: ${id}`);
}

function required(value: string | undefined | null, name: string): string {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${name} is required`);
  return s;
}

function validateEnum<T extends string>(value: string | undefined, allowed: Set<T>, name: string): T {
  if (!value || !allowed.has(value as T)) {
    throw new Error(`${name} must be one of: ${[...allowed].join(', ')}`);
  }
  return value as T;
}
