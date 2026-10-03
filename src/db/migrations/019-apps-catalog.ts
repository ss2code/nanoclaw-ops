import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Apps catalog: semantic map for Jeeves-style supervision.
 *
 * The catalog owns stable handles (for example `goa-trip`) and app meaning.
 * Agent-to-agent destination rows remain derived routing projections.
 */
export const migration019: Migration = {
  version: 19,
  name: 'apps-catalog',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE apps (
        handle         TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('agent', 'service')),
        type           TEXT NOT NULL,
        agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
        purpose        TEXT NOT NULL,
        read_source    TEXT NOT NULL CHECK (read_source IN ('ops-center:/trips', 'ops-center', 'a2a', 'none')),
        visibility     TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
        status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        retired_at     TEXT
      );

      CREATE INDEX idx_apps_agent_group ON apps(agent_group_id);
      CREATE INDEX idx_apps_type ON apps(type);
      CREATE INDEX idx_apps_status ON apps(status);

      CREATE TRIGGER apps_retire_before_agent_group_delete
      BEFORE DELETE ON agent_groups
      FOR EACH ROW
      BEGIN
        UPDATE apps
           SET status = 'retired',
               retired_at = COALESCE(retired_at, datetime('now')),
               updated_at = datetime('now'),
               agent_group_id = NULL
         WHERE agent_group_id = OLD.id;
      END;
    `);
  },
};
