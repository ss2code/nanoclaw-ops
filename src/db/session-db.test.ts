/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { countDueMessages, getInboundSourceSessionId, migrateMessagesInTable } from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

/** Fresh inbound.db with the current messages_in schema. */
function freshInboundDb(): Database.Database {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  TEXT,
      recurrence     TEXT,
      series_id      TEXT,
      tries          INTEGER DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      source_session_id TEXT,
      on_wake        INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

let seq = 0;
function addRow(
  db: Database.Database,
  id: string,
  kind: string,
  fields: { status?: string; trigger?: 0 | 1 } = {},
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
     VALUES (?, ?, ?, datetime('now'), ?, ?, '{}')`,
  ).run(id, (seq += 2), kind, fields.status ?? 'pending', fields.trigger ?? 1);
}

describe('countDueMessages', () => {
  it('excludes kind=system (orphaned question_response) so they never drive a wake', () => {
    const db = freshInboundDb();
    // The exact wedge that held the errand-runner container up: a pending,
    // trigger=1 system row the poll loop discards. It must NOT be counted.
    addRow(db, 'sys-zombie', 'system', { trigger: 1 });
    expect(countDueMessages(db)).toBe(0);
    db.close();
  });

  it('counts real due work and ignores system / accumulate / future / done rows', () => {
    const db = freshInboundDb();
    addRow(db, 'chat-due', 'chat', { trigger: 1 }); // counts
    addRow(db, 'sys-zombie', 'system', { trigger: 1 }); // excluded: system
    addRow(db, 'chat-accumulate', 'chat', { trigger: 0 }); // excluded: accumulate-only
    addRow(db, 'chat-future', 'chat', { trigger: 1 }); // excluded below: process_after in future
    addRow(db, 'chat-done', 'chat', { status: 'completed', trigger: 1 }); // excluded: not pending
    db.prepare(`UPDATE messages_in SET process_after = datetime('now', '+1 hour') WHERE id = 'chat-future'`).run();
    expect(countDueMessages(db)).toBe(1);
    db.close();
  });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});
