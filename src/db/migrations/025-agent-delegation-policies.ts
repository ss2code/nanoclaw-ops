import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Applied direct-delegation templates and the exact ACL rows each template
 * owns. The ownership bit lets revocation remove only rows created by that
 * template while preserving existing/manual destinations.
 */
export const migration025: Migration = {
  version: 25,
  name: 'agent-delegation-policies',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_delegation_policies (
        policy_id       TEXT PRIMARY KEY,
        template_name   TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        template_json   TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at      TEXT NOT NULL,
        revoked_at      TEXT
      );

      CREATE TABLE agent_delegation_policy_edges (
        policy_id       TEXT NOT NULL REFERENCES agent_delegation_policies(policy_id) ON DELETE CASCADE,
        from_group_id   TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        from_local_name TEXT NOT NULL,
        to_group_id     TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        to_local_name   TEXT NOT NULL,
        destination_created INTEGER NOT NULL DEFAULT 0 CHECK (destination_created IN (0, 1)),
        PRIMARY KEY (policy_id, from_group_id, from_local_name, to_group_id)
      );

      CREATE INDEX idx_agent_delegation_policy_edges_from
        ON agent_delegation_policy_edges(from_group_id, to_group_id);
      CREATE INDEX idx_agent_delegation_policy_edges_to
        ON agent_delegation_policy_edges(to_group_id, from_group_id);
    `);
  },
};
