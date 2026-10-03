/**
 * One-time portability migration for additional mounts and their external
 * allowlist. Defaults to a read-only check; pass --write to apply. The write
 * path creates timestamped backups before changing either file.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, MOUNT_ALLOWLIST_PATH } from '../src/config.js';
import { normalizeAdditionalMounts, normalizeMountAllowlist } from '../src/mount-portability.js';
import type { AdditionalMount, MountAllowlist } from '../src/modules/mount-security/index.js';

const write = process.argv.includes('--write');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--write' && arg !== '--check');
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Use --check or --write.`);
  process.exit(2);
}

const homeDir = os.homedir();
const dbPath = path.join(DATA_DIR, 'v2.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Central DB not found: ${dbPath}`);
  process.exit(2);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const db = new Database(dbPath);
let changedConfigs = 0;
let changedAllowlist = false;

try {
  const rows = db
    .prepare('SELECT agent_group_id, additional_mounts FROM container_configs ORDER BY agent_group_id')
    .all() as Array<{ agent_group_id: string; additional_mounts: string }>;
  const updates: Array<{ agent_group_id: string; additional_mounts: string }> = [];
  for (const row of rows) {
    const current = JSON.parse(row.additional_mounts) as AdditionalMount[];
    const normalized = normalizeAdditionalMounts(current, homeDir);
    const serialized = JSON.stringify(normalized);
    if (serialized !== JSON.stringify(current)) {
      updates.push({ agent_group_id: row.agent_group_id, additional_mounts: serialized });
    }
  }
  changedConfigs = updates.length;

  let normalizedAllowlist: MountAllowlist | null = null;
  if (fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
    const current = JSON.parse(fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf8')) as MountAllowlist;
    normalizedAllowlist = normalizeMountAllowlist(current, homeDir);
    changedAllowlist = JSON.stringify(normalizedAllowlist) !== JSON.stringify(current);
  }

  if (write && (updates.length > 0 || changedAllowlist)) {
    const backupDir = path.join(DATA_DIR, 'backups', 'mount-portability');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    await db.backup(path.join(backupDir, `v2-before-mount-normalize-${timestamp}.db`));
    if (fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      fs.copyFileSync(MOUNT_ALLOWLIST_PATH, path.join(backupDir, `mount-allowlist-${timestamp}.json`));
    }
    const update = db.prepare(
      'UPDATE container_configs SET additional_mounts = ?, updated_at = ? WHERE agent_group_id = ?',
    );
    const apply = db.transaction(() => {
      const now = new Date().toISOString();
      for (const row of updates) update.run(row.additional_mounts, now, row.agent_group_id);
    });
    apply();
    if (normalizedAllowlist && changedAllowlist) {
      fs.writeFileSync(MOUNT_ALLOWLIST_PATH, `${JSON.stringify(normalizedAllowlist, null, 2)}\n`, { mode: 0o600 });
    }
  }
} finally {
  db.close();
}

console.log(
  JSON.stringify(
    {
      mode: write ? 'write' : 'check',
      changedConfigs,
      changedAllowlist,
      changesApplied: write && (changedConfigs > 0 || changedAllowlist),
      portableAfterRun: write || (changedConfigs === 0 && !changedAllowlist),
    },
    null,
    2,
  ),
);

if (!write && (changedConfigs > 0 || changedAllowlist)) process.exitCode = 1;
