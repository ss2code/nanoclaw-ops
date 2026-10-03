/**
 * Read-only access to the central DB (data/v2.db). Connections are opened
 * readonly and closed per call — the host owns this file; we only peek.
 */
import Database from 'better-sqlite3';
import { PATHS } from '../config.js';

export interface AgentGroupInfo {
  id: string;
  name: string;
  folder: string;
  model: string | null;
  provider: string | null;
  cli_scope: string | null;
  model_tiers: string | null;
  desired_state?: 'running' | 'stopped' | 'paused';
  lifecycle_status?: 'running' | 'idle' | 'stopped' | 'paused' | 'starting' | 'error';
  lifecycle_error?: string | null;
  lifecycle_revision?: number;
}

export interface GroupConfigSnapshot extends AgentGroupInfo {
  effort: string | null;
  image_tag: string | null;
  assistant_name: string | null;
  max_messages_per_prompt: number | null;
  skills: string | null;
  mcp_servers: string | null;
  packages_apt: string | null;
  packages_npm: string | null;
  additional_mounts: string | null;
  hardening: string | null;
  model_tiers: string | null;
  updated_at: string | null;
}

export interface SessionInfo {
  id: string;
  agent_group_id: string;
  messaging_group_id: string;
  status: string;
  container_status: string | null;
  last_active: string | null;
  created_at: string | null;
}

export interface WiringInfo {
  id: string;
  messaging_group_id: string;
  engage_mode: string;
  ignored_message_policy: string;
  channel_type: string | null;
  instance: string | null;
  // Messaging-group name + platform id, so the UI can label a row by the
  // specific chat rather than a bare channel type (multiple wirings can share
  // one channel). Both nullable to tolerate a LEFT JOIN miss.
  name: string | null;
  platform_id: string | null;
  // 'on' | 'off' — per-chat voice-note transcription (migration 023).
  // Nullable to tolerate a LEFT JOIN miss / pre-migration DB.
  voice_transcription: string | null;
}

export interface AppCatalogInfo {
  handle: string;
  name: string;
  kind: string;
  type: string;
  agent_group_id: string | null;
  purpose: string;
  read_source: string;
  visibility: string;
  status: string;
  updated_at: string | null;
  retired_at: string | null;
}

/**
 * The three engagement presets surfaced in the dashboard. They bundle the raw
 * wiring fields (engage_mode + ignored_message_policy) and, for `context`, the
 * per-group max_messages_per_prompt — see VerifiedActions.setEngageMode.
 */
export type EngagePreset = 'mention' | 'sticky' | 'context';

/**
 * Map a wiring's raw fields to a preset, or null when the state is outside the
 * three presets (e.g. engage_mode=pattern). Null is rendered as "Custom" so the
 * dashboard never misreports an always-on `pattern` wiring as "Mention only".
 */
export function matchPreset(w: { engage_mode: string; ignored_message_policy: string }): EngagePreset | null {
  if (w.engage_mode === 'mention-sticky' && w.ignored_message_policy === 'drop') return 'sticky';
  if (w.engage_mode === 'mention' && w.ignored_message_policy === 'accumulate') return 'context';
  if (w.engage_mode === 'mention' && w.ignored_message_policy === 'drop') return 'mention';
  return null;
}

function open(): Database.Database {
  return new Database(PATHS.centralDb, { readonly: true, fileMustExist: true });
}

export function withCentral<T>(fn: (db: Database.Database) => T): T {
  const db = open();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function listAgentGroups(): AgentGroupInfo[] {
  return withCentral((db) =>
    db
      .prepare(
        `SELECT g.id, g.name, g.folder, c.model, c.provider, c.cli_scope, c.model_tiers,
                COALESCE(l.desired_state, 'running') AS desired_state,
                COALESCE(l.lifecycle_status, 'idle') AS lifecycle_status,
                l.last_error AS lifecycle_error,
                COALESCE(l.revision, 0) AS lifecycle_revision
         FROM agent_groups g LEFT JOIN container_configs c ON c.agent_group_id = g.id
         LEFT JOIN agent_group_lifecycle l ON l.agent_group_id = g.id
         ORDER BY g.name`,
      )
      .all(),
  ) as AgentGroupInfo[];
}

export function getGroupConfig(groupId: string): GroupConfigSnapshot | undefined {
  return withCentral((db) =>
    db
      .prepare(
        `SELECT g.id, g.name, g.folder, c.provider, c.model, c.cli_scope, c.effort,
                c.image_tag, c.assistant_name, c.max_messages_per_prompt, c.skills,
                c.mcp_servers, c.packages_apt, c.packages_npm, c.additional_mounts,
                c.hardening, c.model_tiers, c.updated_at
         FROM agent_groups g LEFT JOIN container_configs c ON c.agent_group_id = g.id
         WHERE g.id = ?`,
      )
      .get(groupId),
  ) as GroupConfigSnapshot | undefined;
}

export interface GroupLifecycleInfo {
  agent_group_id: string;
  desired_state: 'running' | 'stopped' | 'paused';
  lifecycle_status: 'running' | 'idle' | 'stopped' | 'paused' | 'starting' | 'error';
  revision: number;
  last_error: string | null;
  updated_at: string;
  updated_by: string;
}

export function getGroupLifecycle(groupId: string): GroupLifecycleInfo | undefined {
  return withCentral((db) =>
    db
      .prepare(
        'SELECT agent_group_id, desired_state, lifecycle_status, revision, last_error, updated_at, updated_by FROM agent_group_lifecycle WHERE agent_group_id = ?',
      )
      .get(groupId),
  ) as GroupLifecycleInfo | undefined;
}

export function listWiringsForGroup(agentGroupId: string): WiringInfo[] {
  return withCentral((db) =>
    db
      .prepare(
        `SELECT a.id, a.messaging_group_id, a.engage_mode, a.ignored_message_policy,
                m.channel_type, m.instance, m.name, m.platform_id, m.voice_transcription
         FROM messaging_group_agents a
         LEFT JOIN messaging_groups m ON m.id = a.messaging_group_id
         WHERE a.agent_group_id = ?
         ORDER BY a.created_at`,
      )
      .all(agentGroupId),
  ) as WiringInfo[];
}

export interface AgentConnectionInfo {
  direction: 'outbound' | 'inbound';
  localName: string;
  peerLocalName: string | null;
  peerGroupId: string;
  peerName: string;
  peerFolder: string;
  policyIds: string[];
  revokedPolicyIds: string[];
}

/**
 * Read the explicit A2A ACL around one group. This is intentionally separate
 * from channel wirings: agent destinations are both the routing map and the
 * security boundary for container messages.
 */
export function listAgentConnections(agentGroupId: string): AgentConnectionInfo[] {
  return withCentral((db) => {
    const base = db
      .prepare(
        `SELECT 'outbound' AS direction, d.local_name AS local_name,
              (SELECT back.local_name FROM agent_destinations back
               WHERE back.agent_group_id = d.target_id AND back.target_type = 'agent'
                 AND back.target_id = d.agent_group_id LIMIT 1) AS peer_local_name,
              d.agent_group_id AS from_group_id, d.local_name AS from_local_name,
              d.target_id AS to_group_id, d.target_id AS peer_group_id,
              g.name AS peer_name, g.folder AS peer_folder
       FROM agent_destinations d JOIN agent_groups g ON g.id = d.target_id
       WHERE d.agent_group_id = ? AND d.target_type = 'agent'
       UNION ALL
       SELECT 'inbound' AS direction,
              (SELECT back.local_name FROM agent_destinations back
               WHERE back.agent_group_id = ? AND back.target_type = 'agent'
                 AND back.target_id = d.agent_group_id LIMIT 1) AS local_name,
              d.local_name AS peer_local_name,
              d.agent_group_id AS from_group_id, d.local_name AS from_local_name,
              d.target_id AS to_group_id, d.agent_group_id AS peer_group_id,
              g.name AS peer_name, g.folder AS peer_folder
       FROM agent_destinations d JOIN agent_groups g ON g.id = d.agent_group_id
       WHERE d.target_type = 'agent' AND d.target_id = ?
       ORDER BY direction, peer_name, local_name`,
      )
      .all(agentGroupId, agentGroupId, agentGroupId) as Array<{
      direction: 'outbound' | 'inbound';
      local_name: string | null;
      peer_group_id: string;
      peer_name: string;
      peer_folder: string;
      peer_local_name: string | null;
      from_group_id: string;
      from_local_name: string;
      to_group_id: string;
    }>;

    const policyByEdge = new Map<string, { active: string[]; revoked: string[] }>();
    try {
      const policyRows = db
        .prepare(
          `SELECT e.from_group_id, e.from_local_name, e.to_group_id, e.to_local_name,
                e.policy_id, p.status
         FROM agent_delegation_policy_edges e
         JOIN agent_delegation_policies p ON p.policy_id = e.policy_id
         WHERE e.from_group_id = ? OR e.to_group_id = ?`,
        )
        .all(agentGroupId, agentGroupId) as Array<{
        from_group_id: string;
        from_local_name: string;
        to_group_id: string;
        to_local_name: string;
        policy_id: string;
        status: 'active' | 'revoked';
      }>;
      for (const row of policyRows) {
        const key = `${row.from_group_id}\0${row.from_local_name}\0${row.to_group_id}`;
        const bucket = policyByEdge.get(key) ?? { active: [], revoked: [] };
        bucket[row.status].push(row.policy_id);
        policyByEdge.set(key, bucket);
      }
    } catch {
      // Older central DBs may be viewed before the optional policy migration.
    }

    return base.map((row) => {
      const key =
        row.direction === 'outbound'
          ? `${row.from_group_id}\0${row.from_local_name}\0${row.to_group_id}`
          : `${row.from_group_id}\0${row.from_local_name}\0${row.to_group_id}`;
      const policies = policyByEdge.get(key) ?? { active: [], revoked: [] };
      return {
        direction: row.direction,
        localName: row.local_name ?? '—',
        peerLocalName: row.peer_local_name,
        peerGroupId: row.peer_group_id,
        peerName: row.peer_name,
        peerFolder: row.peer_folder,
        policyIds: policies.active,
        revokedPolicyIds: policies.revoked,
      };
    });
  });
}

export interface MemberInfo {
  user_id: string;
  /** Channel prefix of the user id (`whatsapp`, `telegram`, `cli`, …). */
  channel: string;
  display_name: string | null;
  kind: string;
}

/**
 * The allowlist for a group: members from `agent_group_members`, joined to
 * `users` for display names. `channel` is derived from each user id's
 * `<channel>:<handle>` prefix so the dashboard can group members under the
 * channel they belong to. These are the only senders that wake the agent —
 * everyone else on a connected channel is ignored.
 */
export function listMembersForGroup(agentGroupId: string): MemberInfo[] {
  const rows = withCentral((db) =>
    db
      .prepare(
        `SELECT m.user_id, u.display_name, u.kind
         FROM agent_group_members m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.agent_group_id = ?
         ORDER BY u.display_name`,
      )
      .all(agentGroupId),
  ) as { user_id: string; display_name: string | null; kind: string | null }[];
  return rows.map((r) => {
    const i = r.user_id.indexOf(':');
    return {
      user_id: r.user_id,
      channel: i > 0 ? r.user_id.slice(0, i) : '',
      display_name: r.display_name,
      kind: r.kind ?? '',
    };
  });
}

/**
 * Canonical `<channel>:<handle>` id for a sender, matching `agent_group_members`
 * user ids. Adapters are inconsistent: some store the sender already prefixed
 * (`telegram:123`, `cli:alice`), others store the bare handle. Prefixing blindly
 * would double up (`telegram:telegram:123`) and miss the member lookup, so an
 * already-prefixed id passes through unchanged.
 */
export function senderKey(channelType: string | null | undefined, rawId: string): string {
  const ch = channelType ?? '';
  return rawId.startsWith(`${ch}:`) ? rawId : `${ch}:${rawId}`;
}

export function listSessions(): SessionInfo[] {
  return withCentral((db) =>
    db
      .prepare(
        `SELECT id, agent_group_id, messaging_group_id, status, container_status, last_active, created_at
         FROM sessions ORDER BY last_active DESC`,
      )
      .all(),
  ) as SessionInfo[];
}

export interface QueueCounts {
  pendingApprovals: number;
  pendingSenderApprovals: number;
  droppedSenders: number;
  droppedMessages: number;
}

export function queueCounts(): QueueCounts {
  return withCentral((db) => {
    const n = (sql: string): number => {
      try {
        return (db.prepare(sql).get() as { n: number }).n;
      } catch {
        return 0;
      }
    };
    return {
      pendingApprovals: n('SELECT COUNT(*) AS n FROM pending_approvals'),
      pendingSenderApprovals: n('SELECT COUNT(*) AS n FROM pending_sender_approvals'),
      droppedSenders: n('SELECT COUNT(*) AS n FROM unregistered_senders'),
      droppedMessages: n('SELECT COALESCE(SUM(message_count), 0) AS n FROM unregistered_senders'),
    };
  });
}

export function listDroppedSenders(): Record<string, unknown>[] {
  return withCentral((db) => {
    try {
      return db
        .prepare(
          `SELECT channel_type, sender_name, user_id, reason, message_count, first_seen, last_seen
           FROM unregistered_senders ORDER BY last_seen DESC LIMIT 100`,
        )
        .all() as Record<string, unknown>[];
    } catch {
      return [];
    }
  });
}

export function listPendingApprovals(): Record<string, unknown>[] {
  return withCentral((db) => {
    const rows: Record<string, unknown>[] = [];
    for (const t of ['pending_approvals', 'pending_sender_approvals']) {
      try {
        const statusClause = t === 'pending_approvals' ? " WHERE status = 'pending'" : '';
        for (const r of db
          .prepare(`SELECT * FROM ${t}${statusClause} ORDER BY created_at DESC LIMIT 50`)
          .all() as Record<string, unknown>[]) {
          rows.push({ _table: t, ...r });
        }
      } catch {
        /* table may not exist */
      }
    }
    return rows;
  });
}

export function listApps(): AppCatalogInfo[] {
  return withCentral((db) => {
    try {
      return db
        .prepare(
          `SELECT handle, name, kind, type, agent_group_id, purpose, read_source, visibility,
                  status, updated_at, retired_at
           FROM apps
           ORDER BY status, type, handle`,
        )
        .all() as AppCatalogInfo[];
    } catch {
      return [];
    }
  });
}

/** Channel adapters known to the install (from messaging_groups channel types). */
export function channelTypes(): string[] {
  return withCentral((db) =>
    (db.prepare('SELECT DISTINCT channel_type FROM messaging_groups').all() as { channel_type: string }[]).map(
      (r) => r.channel_type,
    ),
  );
}
