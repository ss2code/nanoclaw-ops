import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';

// Ungated working notes (§13, tier 1). Leanings, vetoes, "still to research".
// Written through immediately with NO approval gate — this is intra-day working
// state that survives restarts (read back by recap). NOT curated memory.

export interface NoteRow {
  id: number;
  at: string;
  author_member_id: number | null;
  topic: string | null;
  note: string;
  status: string;
}

export function addNote(
  db: Database,
  n: { authorMemberId?: number | null; topic?: string | null; note: string },
  at: string,
): number {
  const res = db
    .query('INSERT INTO scratchpad (at, author_member_id, topic, note, status) VALUES ($at, $a, $t, $n, $st)')
    .run({ $at: at, $a: n.authorMemberId ?? null, $t: n.topic ?? null, $n: n.note, $st: 'open' });
  const id = Number(res.lastInsertRowid);
  appendJournal(db, {
    at,
    actorId: n.authorMemberId ?? null,
    action: 'scratchpad.add',
    entity: `note:${id}`,
    before: null,
    after: { id, topic: n.topic ?? null, note: n.note, status: 'open' },
  });
  return id;
}

export function resolveNote(db: Database, id: number, at: string): void {
  const before = db.query('SELECT * FROM scratchpad WHERE id = $id').get({ $id: id });
  if (!before) throw new Error(`note ${id} not found`);
  db.query('UPDATE scratchpad SET status = $st WHERE id = $id').run({ $st: 'resolved', $id: id });
  appendJournal(db, {
    at,
    actorId: null,
    action: 'scratchpad.resolve',
    entity: `note:${id}`,
    before,
    after: db.query('SELECT * FROM scratchpad WHERE id = $id').get({ $id: id }),
  });
}

export function openNotes(db: Database): NoteRow[] {
  return db.query("SELECT * FROM scratchpad WHERE status = 'open' ORDER BY id").all() as NoteRow[];
}

export function allNotes(db: Database): NoteRow[] {
  return db.query('SELECT * FROM scratchpad ORDER BY id').all() as NoteRow[];
}
