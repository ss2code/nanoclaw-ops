import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface RegressionArtifactCleanupOptions {
  channelType: string;
  platformPrefix: string;
  sessionRoot: string;
}

export interface RegressionArtifactCleanupSummary {
  messagingGroups: number;
  wirings: number;
  sessions: number;
  destinations: number;
  sessionDirs: number;
}

interface RegressionSessionRef {
  id: string;
  agentGroupId: string;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table));
}

function bindList(values: string[]): string {
  return values.map(() => '?').join(', ');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function removeSessionDirs(sessionRoot: string, sessions: RegressionSessionRef[]): number {
  const root = path.resolve(sessionRoot);
  const rootPrefix = `${root}${path.sep}`;
  let removed = 0;

  for (const session of sessions) {
    const candidate = path.resolve(root, session.agentGroupId, session.id);
    if (!candidate.startsWith(rootPrefix)) continue;
    if (!fs.existsSync(candidate)) continue;

    fs.rmSync(candidate, { recursive: true, force: true });
    removed++;
  }

  return removed;
}

/**
 * Remove synthetic regression channels and their host-side artifacts.
 *
 * The caller must stop containers for matching sessions before invoking this
 * function. It is deliberately scoped to one channel type and a reserved
 * platform-id prefix; it cannot remove ordinary operator channels merely
 * because they share an agent group.
 */
export function cleanupRegressionArtifacts(
  db: Database.Database,
  options: RegressionArtifactCleanupOptions,
): RegressionArtifactCleanupSummary {
  db.pragma('foreign_keys = ON');

  const empty: RegressionArtifactCleanupSummary = {
    messagingGroups: 0,
    wirings: 0,
    sessions: 0,
    destinations: 0,
    sessionDirs: 0,
  };

  const platformLike = `${escapeLike(options.platformPrefix)}%`;
  const targetGroups = db
    .prepare(
      `SELECT id
         FROM messaging_groups
        WHERE channel_type = ?
          AND platform_id LIKE ? ESCAPE '\\'`,
    )
    .all(options.channelType, platformLike) as Array<{ id: string }>;
  if (targetGroups.length === 0) return empty;

  const groupIds = targetGroups.map((row) => row.id);
  const groupParams = [options.channelType, platformLike];
  const groupList = bindList(groupIds);
  const sessions = db
    .prepare(
      `SELECT id, agent_group_id AS agentGroupId
         FROM sessions
        WHERE messaging_group_id IN (${groupList})`,
    )
    .all(...groupIds) as RegressionSessionRef[];
  const sessionIds = sessions.map((row) => row.id);
  const sessionList = sessionIds.length > 0 ? bindList(sessionIds) : '';

  let wirings = 0;
  let sessionCount = 0;
  let destinations = 0;

  const deleteRows = db.transaction(() => {
    if (tableExists(db, 'pending_questions') && sessionIds.length > 0) {
      db.prepare(`DELETE FROM pending_questions WHERE session_id IN (${sessionList})`).run(...sessionIds);
    }
    if (tableExists(db, 'pending_approvals')) {
      if (sessionIds.length > 0) {
        db.prepare(`DELETE FROM pending_approvals WHERE session_id IN (${sessionList})`).run(...sessionIds);
      }
      db.prepare(
        `DELETE FROM pending_approvals
          WHERE channel_type = ? AND platform_id LIKE ? ESCAPE '\\'`,
      ).run(options.channelType, platformLike);
    }
    if (tableExists(db, 'pending_channel_approvals')) {
      db.prepare(`DELETE FROM pending_channel_approvals WHERE messaging_group_id IN (${groupList})`).run(...groupIds);
    }
    if (tableExists(db, 'pending_sender_approvals')) {
      db.prepare(`DELETE FROM pending_sender_approvals WHERE messaging_group_id IN (${groupList})`).run(...groupIds);
    }
    if (tableExists(db, 'user_dms')) {
      db.prepare(`DELETE FROM user_dms WHERE messaging_group_id IN (${groupList})`).run(...groupIds);
    }
    if (tableExists(db, 'unregistered_senders')) {
      db.prepare(`DELETE FROM unregistered_senders WHERE messaging_group_id IN (${groupList})`).run(...groupIds);
    }
    if (tableExists(db, 'agent_destinations')) {
      destinations = db
        .prepare(`DELETE FROM agent_destinations WHERE target_type = 'channel' AND target_id IN (${groupList})`)
        .run(...groupIds).changes;
    }

    wirings = db
      .prepare(`DELETE FROM messaging_group_agents WHERE messaging_group_id IN (${groupList})`)
      .run(...groupIds).changes;
    sessionCount = db
      .prepare(`DELETE FROM sessions WHERE messaging_group_id IN (${groupList})`)
      .run(...groupIds).changes;
    const groups = db
      .prepare(
        `DELETE FROM messaging_groups
          WHERE channel_type = ?
            AND platform_id LIKE ? ESCAPE '\\'`,
      )
      .run(...groupParams).changes;

    return groups;
  })();

  return {
    messagingGroups: deleteRows,
    wirings,
    sessions: sessionCount,
    destinations,
    sessionDirs: removeSessionDirs(options.sessionRoot, sessions),
  };
}
