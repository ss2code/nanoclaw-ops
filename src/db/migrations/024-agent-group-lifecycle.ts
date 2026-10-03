import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Durable per-agent-group lifecycle intent and audit trail.
 *
 * desired_state controls whether a wake is allowed. lifecycle_status is the
 * host's best current observation and is deliberately separate so a paused
 * group can retain queued work while all automatic wakes are suppressed.
 */
export const migration024: Migration = {
  version: 24,
  name: 'agent-group-lifecycle',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_group_lifecycle (
        agent_group_id  TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        desired_state   TEXT NOT NULL DEFAULT 'running'
                        CHECK (desired_state IN ('running', 'stopped', 'paused')),
        lifecycle_status TEXT NOT NULL DEFAULT 'idle'
                        CHECK (lifecycle_status IN ('running', 'idle', 'stopped', 'paused', 'starting', 'error')),
        revision        INTEGER NOT NULL DEFAULT 0,
        updated_at      TEXT NOT NULL,
        updated_by      TEXT NOT NULL DEFAULT 'host',
        last_error      TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_group_lifecycle_audit (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        event           TEXT NOT NULL,
        from_state      TEXT NOT NULL,
        to_state        TEXT NOT NULL,
        revision        INTEGER NOT NULL,
        actor           TEXT NOT NULL,
        detail          TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_group_lifecycle_audit_group
        ON agent_group_lifecycle_audit(agent_group_id, created_at);

      INSERT OR IGNORE INTO agent_group_lifecycle
        (agent_group_id, desired_state, lifecycle_status, revision, updated_at, updated_by)
      SELECT id, 'running', 'idle', 0, created_at, 'migration'
      FROM agent_groups;
    `);
  },
};
