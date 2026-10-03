import { Database } from 'bun:sqlite';

// journal_mode=DELETE for the same reason as the session DBs (see
// container/agent-runner/src/db/connection.ts): trip.db lives in the group
// workspace, which is a bind mount — WAL sidecar files do not propagate
// reliably across the mount boundary, and the host-side simulator/tests
// read this file while the container writes it.
//
// trip-core owns the SHARED tables: identity, roster, relationships, the
// lifecycle stage, per-stage participation, the consensus `decisions` record,
// the ungated `scratchpad`, the `assets` index, and the append-only `journal`.
// Feature skills (trip-finance, trip-planning) layer their own tables into the
// SAME file via their own migrate step, then call these helpers.

export function openCoreDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA foreign_keys = ON');
  migrateCore(db);
  return db;
}

/**
 * Create the shared core tables. Idempotent (IF NOT EXISTS). Safe to run before
 * a feature's own migrate step in the same DB file.
 *
 * The `trip` table is a SUPERSET of finance's original: it keeps `status`
 * (finance's date-effective lifecycle flag, default 'active') unchanged AND
 * adds `stage` (the seven-stage lifecycle machine, §11) + `total_budget`.
 * The two are orthogonal columns — finance keeps reading/writing `status`
 * byte-identically; the lifecycle machine reads/writes `stage`.
 */
export function migrateCore(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trip (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      base_currency TEXT NOT NULL DEFAULT 'INR',
      start_date TEXT,
      end_date TEXT,
      default_split_rule TEXT NOT NULL DEFAULT 'equal-all',
      status TEXT NOT NULL DEFAULT 'draft',
      stage TEXT NOT NULL DEFAULT 'planning',
      total_budget INTEGER
    );

    CREATE TABLE IF NOT EXISTS families (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      family_id INTEGER REFERENCES families(id),
      platform_id TEXT,
      joined_at TEXT NOT NULL,
      left_at TEXT,
      excluded_from_splits INTEGER NOT NULL DEFAULT 0,
      home_place_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id),
      related_member_id INTEGER NOT NULL REFERENCES members(id),
      kind TEXT NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS stage_participation (
      member_id INTEGER NOT NULL REFERENCES members(id),
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in',
      note TEXT,
      PRIMARY KEY (member_id, stage)
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'propose',
      options_json TEXT,
      tally_json TEXT,
      outcome TEXT,
      commit_by TEXT,
      stage TEXT,
      opened_by INTEGER REFERENCES members(id),
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      status TEXT NOT NULL DEFAULT 'open'
    );

    CREATE TABLE IF NOT EXISTS vote_proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_member_id INTEGER NOT NULL REFERENCES members(id),
      to_member_id INTEGER NOT NULL REFERENCES members(id),
      decision_id INTEGER REFERENCES decisions(id),
      scope TEXT NOT NULL DEFAULT 'all',
      note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      set_by INTEGER REFERENCES members(id),
      set_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'researching',
      source_url TEXT,
      source_checked_at TEXT,
      confidence TEXT NOT NULL DEFAULT 'unknown',
      freshness_days INTEGER,
      note TEXT,
      created_by INTEGER REFERENCES members(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_signups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity TEXT NOT NULL,
      member_id INTEGER NOT NULL REFERENCES members(id),
      status TEXT NOT NULL DEFAULT 'interested',
      note TEXT,
      updated_by INTEGER REFERENCES members(id),
      updated_at TEXT NOT NULL,
      UNIQUE(activity, member_id)
    );

    CREATE TABLE IF NOT EXISTS scratchpad (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      author_member_id INTEGER REFERENCES members(id),
      topic TEXT,
      note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );

    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      label TEXT,
      path TEXT NOT NULL,
      added_by INTEGER REFERENCES members(id),
      stage TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor_member_id INTEGER,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT
    );

    CREATE TABLE IF NOT EXISTS checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by INTEGER REFERENCES members(id)
    );
    CREATE TABLE IF NOT EXISTS checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checklist_id INTEGER NOT NULL REFERENCES checklists(id),
      label TEXT NOT NULL,
      due_date TEXT,
      per_member INTEGER NOT NULL DEFAULT 0,
      claimed_by INTEGER REFERENCES members(id),
      status TEXT NOT NULL DEFAULT 'open',
      note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(checklist_id, label)
    );
    CREATE TABLE IF NOT EXISTS checklist_confirmations (
      item_id INTEGER NOT NULL REFERENCES checklist_items(id),
      member_id INTEGER NOT NULL REFERENCES members(id),
      at TEXT NOT NULL,
      PRIMARY KEY (item_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS rollcalls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      opened_by INTEGER REFERENCES members(id),
      opened_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS rollcall_checkins (
      rollcall_id INTEGER NOT NULL REFERENCES rollcalls(id),
      member_id INTEGER NOT NULL REFERENCES members(id),
      at TEXT NOT NULL,
      note TEXT,
      PRIMARY KEY (rollcall_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS diary_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      member_id INTEGER REFERENCES members(id),
      entry TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'assets', 'day_date', 'day_date TEXT');
  ensureColumn(db, 'assets', 'place_id', 'place_id INTEGER');
  ensureColumn(db, 'members', 'upi_id', 'upi_id TEXT');
}

/** Additive, idempotent column migration. `ddl` is the full column definition. */
export function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export interface MemberRow {
  id: number;
  display_name: string;
  aliases: string;
  family_id: number | null;
  platform_id: string | null;
  joined_at: string;
  left_at: string | null;
  excluded_from_splits: number;
  home_place_id: number | null;
}

export function getMember(db: Database, id: number): MemberRow | null {
  return db.query('SELECT * FROM members WHERE id = $id').get({ $id: id }) as MemberRow | null;
}

export function allMembers(db: Database): MemberRow[] {
  return db.query('SELECT * FROM members ORDER BY id').all() as MemberRow[];
}

/**
 * Members active at `atIso` (joined on/before, not yet left) and not flagged
 * excluded_from_splits — the pool automatic split rules divide among.
 * ISO-8601 strings compare lexicographically, so '2026-12-22' <= '2026-12-22T10:00:00'.
 */
export function activeParticipants(db: Database, atIso: string): MemberRow[] {
  return db
    .query(
      `SELECT * FROM members
       WHERE joined_at <= $at AND (left_at IS NULL OR left_at > $at)
         AND excluded_from_splits = 0
       ORDER BY id`,
    )
    .all({ $at: atIso }) as MemberRow[];
}

/** Active members regardless of the excluded_from_splits flag — eligible for explicit shares. */
export function activeMembers(db: Database, atIso: string): MemberRow[] {
  return db
    .query(
      `SELECT * FROM members
       WHERE joined_at <= $at AND (left_at IS NULL OR left_at > $at)
       ORDER BY id`,
    )
    .all({ $at: atIso }) as MemberRow[];
}

export function appendJournal(
  db: Database,
  entry: {
    at: string;
    actorId: number | null;
    action: string;
    entity: string;
    before: unknown;
    after: unknown;
  },
): void {
  db.query(
    `INSERT INTO journal (at, actor_member_id, action, entity, before_json, after_json)
     VALUES ($at, $actor, $action, $entity, $before, $after)`,
  ).run({
    $at: entry.at,
    $actor: entry.actorId,
    $action: entry.action,
    $entity: entry.entity,
    $before: entry.before == null ? null : JSON.stringify(entry.before),
    $after: entry.after == null ? null : JSON.stringify(entry.after),
  });
}
