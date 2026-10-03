import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Per-group high/medium/low model tiers for OpenCode/OpenRouter groups.
 * NULL = no tiers (default; the group uses its single `model` / provider env).
 * When set, a JSON object: { high, medium, low, default } where each tier is a
 * catalog model id and `default` names the tier that supplies the group's
 * default model. Read at spawn to materialize the OpenCode model config.
 */
export const migration021: Migration = {
  version: 21,
  name: 'model-tiers',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN model_tiers TEXT').run();
  },
};
