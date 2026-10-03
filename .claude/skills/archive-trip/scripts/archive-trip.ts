#!/usr/bin/env node

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

export type ArchiveAction = 'preview' | 'archive';

export interface ArchiveArgs {
  action: ArchiveAction;
  id: string;
  yes: boolean;
  json: boolean;
  includeNodeModules: boolean;
  output?: string;
}

export interface ArchiveSnapshot {
  agentGroup: {
    id: string;
    name: string;
    folder: string;
    created_at: string;
  };
  lifecycle: {
    desired_state: string;
    lifecycle_status: string;
    revision: number;
    updated_at: string;
    updated_by: string;
  };
  trip: {
    name: string;
    status: string;
    stage: string;
    base_currency: string;
    start_date: string | null;
    end_date: string | null;
  } | null;
  wires: Array<{
    channel_type: string;
    platform_id: string;
    name: string | null;
    engage_mode: string;
    sender_scope: string;
    ignored_message_policy: string;
  }>;
  members: number;
  sessions: Array<{
    id: string;
    status: string;
    container_status: string;
    last_active: string | null;
    pending_messages: number;
    processing_claims: number;
  }>;
  hostRecords: HostArchiveRecords;
  runtime_containers: string[] | null;
  ready: boolean;
  blockers: string[];
}

export type HostArchiveRecords = Record<string, Array<Record<string, unknown>>>;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(scriptDir, '../../../../');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const GROUPS_DIR = path.join(REPO_ROOT, 'groups');
export const ARCHIVE_DIR = path.join(DATA_DIR, 'trip-archives');

function usage(): never {
  throw new Error(
    'usage: archive-trip preview|archive --id <agent-group-id|folder> [--json] [--yes] [--include-node-modules] [--output <path>]',
  );
}

export function parseArgs(argv: string[]): ArchiveArgs {
  const [action, ...rest] = argv;
  if (action !== 'preview' && action !== 'archive') usage();

  let id = '';
  let output: string | undefined;
  let yes = false;
  let json = false;
  let includeNodeModules = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--id') id = rest[++i] ?? '';
    else if (arg === '--output') output = rest[++i];
    else if (arg === '--yes') yes = true;
    else if (arg === '--json') json = true;
    else if (arg === '--include-node-modules') includeNodeModules = true;
    else usage();
  }
  if (!id) usage();
  return { action, id, yes, json, includeNodeModules, output };
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function selectRows(db: Database.Database, table: string, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  if (!tableExists(db, table)) return [];
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

function inClause(values: string[]): string {
  return values.length ? `(${values.map(() => '?').join(',')})` : '(NULL)';
}

function readHostRecords(db: Database.Database, agentGroupId: string): HostArchiveRecords {
  const agentGroup = selectRows(db, 'agent_groups', 'SELECT * FROM agent_groups WHERE id = ?', agentGroupId);
  const lifecycle = selectRows(
    db,
    'agent_group_lifecycle',
    'SELECT * FROM agent_group_lifecycle WHERE agent_group_id = ?',
    agentGroupId,
  );
  const lifecycleAudit = selectRows(
    db,
    'agent_group_lifecycle_audit',
    'SELECT * FROM agent_group_lifecycle_audit WHERE agent_group_id = ? ORDER BY id',
    agentGroupId,
  );
  const containerConfigs = selectRows(
    db,
    'container_configs',
    'SELECT * FROM container_configs WHERE agent_group_id = ?',
    agentGroupId,
  );
  const messagingGroupAgents = selectRows(
    db,
    'messaging_group_agents',
    'SELECT * FROM messaging_group_agents WHERE agent_group_id = ? ORDER BY id',
    agentGroupId,
  );
  const messagingGroupIds = messagingGroupAgents
    .map((row) => String(row.messaging_group_id))
    .filter(Boolean);
  const messagingGroups = selectRows(
    db,
    'messaging_groups',
    `SELECT * FROM messaging_groups WHERE id IN ${inClause(messagingGroupIds)} ORDER BY id`,
    ...messagingGroupIds,
  );
  const members = selectRows(
    db,
    'agent_group_members',
    'SELECT * FROM agent_group_members WHERE agent_group_id = ? ORDER BY user_id',
    agentGroupId,
  );
  const scopedRoles = selectRows(
    db,
    'user_roles',
    'SELECT * FROM user_roles WHERE agent_group_id = ? ORDER BY user_id, role',
    agentGroupId,
  );
  const sessions = selectRows(
    db,
    'sessions',
    'SELECT * FROM sessions WHERE agent_group_id = ? ORDER BY created_at, id',
    agentGroupId,
  );
  const sessionIds = sessions.map((row) => String(row.id)).filter(Boolean);
  const userIds = Array.from(
    new Set([
      ...members.map((row) => String(row.user_id)),
      ...scopedRoles.map((row) => String(row.user_id)),
    ].filter(Boolean)),
  );
  const users = selectRows(
    db,
    'users',
    `SELECT * FROM users WHERE id IN ${inClause(userIds)} ORDER BY id`,
    ...userIds,
  );
  const userDms = selectRows(
    db,
    'user_dms',
    `SELECT * FROM user_dms WHERE user_id IN ${inClause(userIds)} OR messaging_group_id IN ${inClause(messagingGroupIds)} ORDER BY user_id, channel_type`,
    ...userIds,
    ...messagingGroupIds,
  );
  const pendingQuestions = selectRows(
    db,
    'pending_questions',
    `SELECT * FROM pending_questions WHERE session_id IN ${inClause(sessionIds)} ORDER BY question_id`,
    ...sessionIds,
  );
  const pendingApprovals = selectRows(
    db,
    'pending_approvals',
    `SELECT * FROM pending_approvals WHERE agent_group_id = ? OR session_id IN ${inClause(sessionIds)} ORDER BY approval_id`,
    agentGroupId,
    ...sessionIds,
  );
  const pendingSenderApprovals = selectRows(
    db,
    'pending_sender_approvals',
    'SELECT * FROM pending_sender_approvals WHERE agent_group_id = ? ORDER BY id',
    agentGroupId,
  );
  const pendingChannelApprovals = selectRows(
    db,
    'pending_channel_approvals',
    'SELECT * FROM pending_channel_approvals WHERE agent_group_id = ? ORDER BY messaging_group_id',
    agentGroupId,
  );
  const agentDestinationsOwned = selectRows(
    db,
    'agent_destinations',
    'SELECT * FROM agent_destinations WHERE agent_group_id = ? ORDER BY local_name',
    agentGroupId,
  );
  const agentDestinationsPointing = selectRows(
    db,
    'agent_destinations',
    "SELECT * FROM agent_destinations WHERE target_type = 'agent' AND target_id = ? ORDER BY agent_group_id, local_name",
    agentGroupId,
  );
  const apps = selectRows(
    db,
    'apps',
    'SELECT * FROM apps WHERE agent_group_id = ? ORDER BY handle',
    agentGroupId,
  );
  const agentMessagePolicies = selectRows(
    db,
    'agent_message_policies',
    'SELECT * FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ? ORDER BY from_agent_group_id, to_agent_group_id',
    agentGroupId,
    agentGroupId,
  );
  const a2aDelegations = selectRows(
    db,
    'a2a_delegations',
    'SELECT * FROM a2a_delegations WHERE from_group = ? OR to_group = ? ORDER BY id',
    agentGroupId,
    agentGroupId,
  );
  const policyEdges = selectRows(
    db,
    'agent_delegation_policy_edges',
    'SELECT * FROM agent_delegation_policy_edges WHERE from_group_id = ? OR to_group_id = ? ORDER BY policy_id, from_group_id, to_group_id',
    agentGroupId,
    agentGroupId,
  );
  const policyIds = Array.from(new Set(policyEdges.map((row) => String(row.policy_id)).filter(Boolean)));
  const delegationPolicies = selectRows(
    db,
    'agent_delegation_policies',
    `SELECT * FROM agent_delegation_policies WHERE policy_id IN ${inClause(policyIds)} ORDER BY policy_id`,
    ...policyIds,
  );

  return {
    agent_groups: agentGroup,
    agent_group_lifecycle: lifecycle,
    agent_group_lifecycle_audit: lifecycleAudit,
    container_configs: containerConfigs,
    messaging_groups: messagingGroups,
    messaging_group_agents: messagingGroupAgents,
    users,
    agent_group_members: members,
    user_roles: scopedRoles,
    user_dms: userDms,
    sessions,
    pending_questions: pendingQuestions,
    pending_approvals: pendingApprovals,
    pending_sender_approvals: pendingSenderApprovals,
    pending_channel_approvals: pendingChannelApprovals,
    agent_destinations_owned: agentDestinationsOwned,
    agent_destinations_pointing: agentDestinationsPointing,
    apps,
    agent_message_policies: agentMessagePolicies,
    a2a_delegations: a2aDelegations,
    agent_delegation_policies: delegationPolicies,
    agent_delegation_policy_edges: policyEdges,
  };
}

function readTrip(folder: string): ArchiveSnapshot['trip'] {
  const tripDbPath = path.join(GROUPS_DIR, folder, 'trip.db');
  if (!existsSync(tripDbPath)) return null;
  const db = new Database(tripDbPath, { readonly: true });
  try {
    if (!tableExists(db, 'trip')) return null;
    return db
      .prepare(
        'SELECT name,status,stage,base_currency,start_date,end_date FROM trip WHERE id = 1',
      )
      .get() as ArchiveSnapshot['trip'];
  } finally {
    db.close();
  }
}

function readSessionCounts(sessionDir: string): { pending_messages: number; processing_claims: number } {
  const inboundPath = path.join(sessionDir, 'inbound.db');
  const outboundPath = path.join(sessionDir, 'outbound.db');
  let pending_messages = 0;
  let processing_claims = 0;
  if (existsSync(inboundPath)) {
    const db = new Database(inboundPath, { readonly: true });
    try {
      pending_messages = (
        db
          .prepare("SELECT COUNT(*) AS n FROM messages_in WHERE status = 'pending' AND kind != 'system'")
          .get() as { n: number }
      ).n;
    } finally {
      db.close();
    }
  }
  if (existsSync(outboundPath)) {
    const db = new Database(outboundPath, { readonly: true });
    try {
      if (tableExists(db, 'processing_ack')) {
        processing_claims = (
          db.prepare("SELECT COUNT(*) AS n FROM processing_ack WHERE status = 'processing'").get() as { n: number }
        ).n;
      }
    } finally {
      db.close();
    }
  }
  return { pending_messages, processing_claims };
}

function resolveGroup(db: Database.Database, idOrFolder: string): { id: string; name: string; folder: string; created_at: string } {
  const row = db
    .prepare('SELECT id,name,folder,created_at FROM agent_groups WHERE id = ? OR folder = ?')
    .get(idOrFolder, idOrFolder) as { id: string; name: string; folder: string; created_at: string } | undefined;
  if (!row) throw new Error(`agent group not found: ${idOrFolder}`);
  return row;
}

function runtimeContainers(folder: string): string[] | null {
  try {
    const output = execFileSync(
      'docker',
      ['ps', '--filter', `name=nanoclaw-v2-${folder}-`, '--format', '{{.Names}}'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    // Fall back to central session status when the runtime cannot be queried.
    // The host pause command has already been used as the authoritative stop
    // request; callers must not infer quiescence when this check is unavailable.
    return null;
  }
}

export function inspectGroup(idOrFolder: string): ArchiveSnapshot {
  const centralPath = path.join(DATA_DIR, 'v2.db');
  if (!existsSync(centralPath)) throw new Error(`central DB not found: ${centralPath}`);
  const db = new Database(centralPath, { readonly: true });
  try {
    const agentGroup = resolveGroup(db, idOrFolder);
    const lifecycle = db
      .prepare(
        'SELECT desired_state,lifecycle_status,revision,updated_at,updated_by FROM agent_group_lifecycle WHERE agent_group_id = ?',
      )
      .get(agentGroup.id) as ArchiveSnapshot['lifecycle'] | undefined;
    if (!lifecycle) throw new Error(`lifecycle row not found for agent group: ${agentGroup.id}`);

    const wires = db
      .prepare(
        `SELECT mg.channel_type,mg.platform_id,mg.name,mga.engage_mode,mga.sender_scope,mga.ignored_message_policy
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mga.agent_group_id = ? ORDER BY mg.channel_type,mg.platform_id`,
      )
      .all(agentGroup.id) as ArchiveSnapshot['wires'];
    const members = (
      db.prepare('SELECT COUNT(*) AS n FROM agent_group_members WHERE agent_group_id = ?').get(agentGroup.id) as { n: number }
    ).n;
    const sessions = db
      .prepare(
        'SELECT id,status,container_status,last_active FROM sessions WHERE agent_group_id = ? ORDER BY created_at',
      )
      .all(agentGroup.id) as Array<Omit<ArchiveSnapshot['sessions'][number], 'pending_messages' | 'processing_claims'>>;
    const withCounts = sessions.map((session) => ({
      ...session,
      ...readSessionCounts(path.join(DATA_DIR, 'v2-sessions', agentGroup.id, session.id)),
    }));
    const hostRecords = readHostRecords(db, agentGroup.id);
    const runtime_containers = runtimeContainers(agentGroup.folder);
    const trip = readTrip(agentGroup.folder);
    const blockers: string[] = [];
    if (!trip) blockers.push('groups/<folder>/trip.db is missing or has no trip row');
    else if (!['archived', 'cancelled'].includes(trip.stage)) {
      blockers.push(`trip-domain stage is '${trip.stage}', expected 'archived' or 'cancelled'`);
    }
    const pending = withCounts.reduce((sum, session) => sum + session.pending_messages, 0);
    const processing = withCounts.reduce((sum, session) => sum + session.processing_claims, 0);
    if (pending) blockers.push(`${pending} pending message(s) remain in session DBs`);
    if (processing) blockers.push(`${processing} in-flight processing claim(s) remain in session DBs`);
    if (withCounts.some((session) => ['running', 'idle'].includes(session.container_status))) {
      blockers.push('one or more containers are still running; archive will stop them before snapshotting');
    }
    return {
      agentGroup,
      lifecycle,
      trip,
      wires,
      members,
      sessions: withCounts,
      hostRecords,
      runtime_containers,
      ready: blockers.every((blocker) => blocker.startsWith('one or more containers')),
      blockers,
    };
  } finally {
    db.close();
  }
}

function print(snapshot: ArchiveSnapshot, json: boolean): void {
  if (json) {
    const { hostRecords, ...publicSnapshot } = snapshot;
    console.log(
      JSON.stringify(
        {
          ...publicSnapshot,
          host_record_counts: Object.fromEntries(
            Object.entries(hostRecords).map(([table, rows]) => [table, rows.length]),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`Trip: ${snapshot.agentGroup.name} (${snapshot.agentGroup.id})`);
  console.log(`Domain stage: ${snapshot.trip?.stage ?? 'missing'} · host lifecycle: ${snapshot.lifecycle.desired_state}/${snapshot.lifecycle.lifecycle_status}`);
  console.log(`Wires: ${snapshot.wires.length} · members: ${snapshot.members} · sessions: ${snapshot.sessions.length}`);
  for (const session of snapshot.sessions) {
    console.log(`  ${session.id}: ${session.container_status} · pending ${session.pending_messages} · processing ${session.processing_claims}`);
  }
  if (snapshot.blockers.length) {
    console.log('Notes/blockers:');
    for (const blocker of snapshot.blockers) console.log(`  - ${blocker}`);
  }
  console.log(`Ready: ${snapshot.ready ? 'yes' : 'no'}`);
}

function nodeCliPath(): string {
  return path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

function pauseGroup(id: string): void {
  try {
    execFileSync(process.execPath, [nodeCliPath(), 'src/cli/client.ts', 'groups', 'pause', '--id', id, '--json'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    throw new Error(stderr.trim() || `failed to pause agent group ${id}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForStopped(id: string, timeoutMs = 30_000): Promise<ArchiveSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = inspectGroup(id);
  while (
    snapshot.sessions.some((session) => ['running', 'idle'].includes(session.container_status)) &&
    !(snapshot.runtime_containers && snapshot.runtime_containers.length === 0)
  ) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for all containers to stop');
    await sleep(500);
    snapshot = inspectGroup(id);
  }
  return snapshot;
}

export function archiveFilename(folder: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${folder}-${stamp}.tar.gz`;
}

export function buildTarArgs(
  archivePath: string,
  folder: string,
  groupId: string,
  stagingDir: string,
  includeNodeModules: boolean,
): string[] {
  const args = ['-czf', archivePath];
  if (!includeNodeModules) args.push('--exclude', `groups/${folder}/node_modules`);
  args.push(
    '-C',
    REPO_ROOT,
    `groups/${folder}`,
    `data/v2-sessions/${groupId}`,
    '-C',
    stagingDir,
    'manifest.json',
    'host-records.json',
  );
  return args;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function safeArchivePath(output: string | undefined, folder: string): string {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archivePath = path.resolve(output ?? path.join(ARCHIVE_DIR, archiveFilename(folder)));
  const relative = path.relative(ARCHIVE_DIR, archivePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`archive output must stay under ${ARCHIVE_DIR}`);
  }
  if (!archivePath.endsWith('.tar.gz')) throw new Error('archive output must end with .tar.gz');
  if (existsSync(archivePath)) throw new Error(`archive already exists: ${archivePath}`);
  return archivePath;
}

function archiveManifest(snapshot: ArchiveSnapshot, includeNodeModules: boolean): Record<string, unknown> {
  return {
    schema: 2,
    archived_at: new Date().toISOString(),
    agent_group: snapshot.agentGroup,
    lifecycle: snapshot.lifecycle,
    trip: snapshot.trip,
    wires: snapshot.wires,
    members: snapshot.members,
    sessions: snapshot.sessions,
    source_paths: {
      group: path.join('groups', snapshot.agentGroup.folder),
      sessions: path.join('data', 'v2-sessions', snapshot.agentGroup.id),
    },
    excluded_paths: includeNodeModules ? [] : [path.join('groups', snapshot.agentGroup.folder, 'node_modules')],
    runtime_containers_at_snapshot: snapshot.runtime_containers,
    host_records_path: 'host-records.json',
    host_record_counts: Object.fromEntries(
      Object.entries(snapshot.hostRecords).map(([table, rows]) => [table, rows.length]),
    ),
  };
}

function archiveEntries(archivePath: string): Set<string> {
  const output = execFileSync('tar', ['-tzf', archivePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Set(output.split('\n').map((entry) => entry.trim()).filter(Boolean));
}

async function verifyArchive(archivePath: string, snapshot: ArchiveSnapshot): Promise<{ bytes: number; sha256: string }> {
  if (!existsSync(archivePath)) throw new Error(`archive was not created: ${archivePath}`);
  const entries = archiveEntries(archivePath);
  const requiredEntries = [
    `groups/${snapshot.agentGroup.folder}/`,
    `data/v2-sessions/${snapshot.agentGroup.id}/`,
    'manifest.json',
    'host-records.json',
  ];
  for (const required of requiredEntries) {
    if (!entries.has(required) && !Array.from(entries).some((entry) => entry.startsWith(required))) {
      throw new Error(`archive is missing required entry: ${required}`);
    }
  }
  const stat = statSync(archivePath);
  return { bytes: stat.size, sha256: await sha256(archivePath) };
}

function safePurgePath(baseDir: string, child: string, label: string): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, child);
  const relative = path.relative(base, target);
  if (!child || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to purge unsafe ${label} path: ${target}`);
  }
  return target;
}

export function buildPurgePaths(groupId: string, folder: string): { groupPath: string; sessionPath: string } {
  return {
    groupPath: safePurgePath(GROUPS_DIR, folder, 'group'),
    sessionPath: safePurgePath(path.join(DATA_DIR, 'v2-sessions'), groupId, 'session'),
  };
}

function deleteCentralGroup(groupId: string): void {
  try {
    execFileSync(
      process.execPath,
      [nodeCliPath(), 'src/cli/client.ts', 'groups', 'delete', '--id', groupId, '--json'],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    throw new Error(stderr.trim() || `failed to delete central records for agent group ${groupId}`);
  }
}

function verifyPurged(snapshot: ArchiveSnapshot, purgePaths: { groupPath: string; sessionPath: string }): void {
  if (existsSync(purgePaths.groupPath)) throw new Error(`group folder still exists after purge: ${purgePaths.groupPath}`);
  if (existsSync(purgePaths.sessionPath)) throw new Error(`session tree still exists after purge: ${purgePaths.sessionPath}`);
  const db = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(snapshot.agentGroup.id);
    if (row) throw new Error(`central agent-group row still exists after purge: ${snapshot.agentGroup.id}`);
  } finally {
    db.close();
  }
}

function purgeGroup(snapshot: ArchiveSnapshot): { groupPath: string; sessionPath: string } {
  const purgePaths = buildPurgePaths(snapshot.agentGroup.id, snapshot.agentGroup.folder);
  deleteCentralGroup(snapshot.agentGroup.id);
  rmSync(purgePaths.groupPath, { recursive: true, force: true });
  rmSync(purgePaths.sessionPath, { recursive: true, force: true });
  verifyPurged(snapshot, purgePaths);
  return purgePaths;
}

export async function archiveGroup(args: ArchiveArgs): Promise<Record<string, unknown>> {
  let snapshot = inspectGroup(args.id);
  if (!snapshot.trip || !['archived', 'cancelled'].includes(snapshot.trip.stage)) {
    throw new Error(snapshot.blockers.join('; '));
  }
  if (snapshot.sessions.some((session) => session.pending_messages || session.processing_claims)) {
    throw new Error(snapshot.blockers.join('; '));
  }
  if (!args.yes) throw new Error('refusing to archive without --yes');

  if (snapshot.lifecycle.desired_state !== 'paused') pauseGroup(snapshot.agentGroup.id);
  snapshot = await waitForStopped(snapshot.agentGroup.id);
  if (snapshot.sessions.some((session) => session.pending_messages || session.processing_claims)) {
    throw new Error('new pending or in-flight work appeared while pausing; group remains paused');
  }

  const archivePath = safeArchivePath(args.output, snapshot.agentGroup.folder);
  const stagingDir = mkdtempSync(path.join(os.tmpdir(), `nanoclaw-archive-${snapshot.agentGroup.id}-`));
  try {
    const manifest = archiveManifest(snapshot, args.includeNodeModules);
    writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(path.join(stagingDir, 'host-records.json'), JSON.stringify(snapshot.hostRecords, null, 2) + '\n');
    execFileSync('tar', buildTarArgs(archivePath, snapshot.agentGroup.folder, snapshot.agentGroup.id, stagingDir, args.includeNodeModules), {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    const archive = await verifyArchive(archivePath, snapshot);
    const sidecar = {
      ...manifest,
      archive: { path: archivePath, ...archive },
    };
    writeFileSync(`${archivePath}.manifest.json`, JSON.stringify(sidecar, null, 2) + '\n');
    const purgedPaths = purgeGroup(snapshot);
    return { ...sidecar, purged: true, purged_paths: purgedPaths };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.action === 'preview') {
    print(inspectGroup(args.id), args.json);
    return;
  }
  const result = await archiveGroup(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(
    `Archive created and source purged: ${(result.archive as { path: string }).path}\nSHA-256: ${(result.archive as { sha256: string }).sha256}`,
  );
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
