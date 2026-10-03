import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Per-group isolation hardening profile. NULL = hardening off (default,
 * today's behavior). When set, a JSON object:
 *   { egress, allowHosts, caps: { pidsLimit, memory, cpus, tmpfs,
 *     noNewPrivileges, capDrop }, scrub }
 * Read at spawn time by the container runner; `scrub` is materialized into
 * container.json for the agent-runner.
 */
export const migration020: Migration = {
  version: 20,
  name: 'hardening-config',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN hardening TEXT').run();
  },
};
