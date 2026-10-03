import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';
export function addDiary(db: Database, d: { date: string; entry: string; memberId?: number | null }, actorId: number | null, at: string): number {
  const id = Number(db.query('INSERT INTO diary_entries (date, member_id, entry, created_at) VALUES ($d,$m,$e,$at)').run({ $d: d.date, $m: d.memberId ?? null, $e: d.entry, $at: at }).lastInsertRowid);
  appendJournal(db, { at, actorId, action: 'diary.add', entity: `diary:${id}`, before: null, after: { date: d.date, member_id: d.memberId ?? null } }); return id;
}
export function diaryEntries(db: Database, date?: string): any[] { return db.query(`SELECT d.*,m.display_name FROM diary_entries d LEFT JOIN members m ON m.id=d.member_id${date ? ' WHERE d.date=$date' : ''} ORDER BY d.date,d.id`).all(date ? { $date: date } : {}) as any[]; }
