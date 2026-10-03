import { Database } from 'bun:sqlite';
import { migrateCore, openCoreDb } from '../../trip-core/scripts/db';

// trip-finance consumes trip-core for the shared roster/journal tables and
// helpers (design §6 — the extraction). This module re-exports those so every
// existing importer (`./db`) keeps resolving unchanged, and owns ONLY the
// finance-specific tables (expenses / expense_shares / settlements).
//
// journal_mode=DELETE rationale lives in trip-core/scripts/db.ts.

export {
  type MemberRow,
  getMember,
  allMembers,
  activeParticipants,
  activeMembers,
  appendJournal,
} from '../../trip-core/scripts/db';

/** Finance-only tables. Layered into the same trip.db on top of the core tables. */
export function migrateFinance(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      payer_member_id INTEGER NOT NULL REFERENCES members(id),
      split_rule TEXT NOT NULL,
      custom_spec TEXT,
      source TEXT NOT NULL DEFAULT 'text',
      logged_by INTEGER REFERENCES members(id),
      logged_at TEXT NOT NULL,
      voided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS expense_shares (
      expense_id INTEGER NOT NULL REFERENCES expenses(id),
      member_id INTEGER NOT NULL REFERENCES members(id),
      share_amount INTEGER NOT NULL,
      PRIMARY KEY (expense_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS expense_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL REFERENCES expenses(id),
      label TEXT NOT NULL,
      amount INTEGER NOT NULL,
      participants_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_member INTEGER NOT NULL REFERENCES members(id),
      to_member INTEGER NOT NULL REFERENCES members(id),
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      logged_by INTEGER REFERENCES members(id),
      logged_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settlement_nudges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      edges_json TEXT NOT NULL
    );
  `);
}

/** Open a trip.db with the core tables + the finance tables migrated. */
export function openDb(path: string): Database {
  const db = openCoreDb(path);
  migrateFinance(db);
  return db;
}

// `migrateCore` re-exported for callers that want to layer onto an existing handle.
export { migrateCore };
