import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';

function current(db: Database): any {
  const row = db.query('SELECT * FROM rollcalls WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get() as any;
  if (!row) throw new Error('no roll-call is open');
  return row;
}
function expected(db: Database): any[] {
  return db.query(`SELECT m.id,m.display_name FROM members m LEFT JOIN stage_participation p ON p.member_id=m.id AND p.stage='on_trip' WHERE m.left_at IS NULL AND COALESCE(p.status,'in') != 'out' ORDER BY m.id`).all() as any[];
}
export function openRollcall(db: Database, label: string, actorId: number | null, at: string): number {
  const existing = db.query('SELECT id FROM rollcalls WHERE closed_at IS NULL').get(); if (existing) throw new Error('a roll-call is already open');
  const id = Number(db.query('INSERT INTO rollcalls (label, opened_by, opened_at) VALUES ($l,$by,$at)').run({ $l: label, $by: actorId, $at: at }).lastInsertRowid);
  appendJournal(db, { at, actorId, action: 'rollcall.open', entity: `rollcall:${id}`, before: null, after: { label } }); return id;
}
export function checkIn(db: Database, memberId: number, note: string | null, actorId: number | null, at: string): void {
  const r = current(db); const before = db.query('SELECT * FROM rollcall_checkins WHERE rollcall_id=$r AND member_id=$m').get({ $r: r.id, $m: memberId });
  db.query(`INSERT INTO rollcall_checkins (rollcall_id,member_id,at,note) VALUES ($r,$m,$at,$n) ON CONFLICT(rollcall_id,member_id) DO UPDATE SET at=excluded.at,note=excluded.note`).run({ $r: r.id, $m: memberId, $at: at, $n: note });
  appendJournal(db, { at, actorId, action: 'rollcall.in', entity: `rollcall:${r.id}`, before, after: { member_id: memberId, note } });
}
export function rollcallStatus(db: Database): { rollcall: any; in: any[]; missing: any[]; complete: boolean } {
  const r = current(db); const roster = expected(db); const present = db.query(`SELECT c.*,m.display_name FROM rollcall_checkins c JOIN members m ON m.id=c.member_id WHERE c.rollcall_id=$r ORDER BY c.member_id`).all({ $r: r.id }) as any[];
  return { rollcall: r, in: present, missing: roster.filter((m) => !present.some((p) => p.member_id === m.id)), complete: roster.every((m) => present.some((p) => p.member_id === m.id)) };
}
export function closeRollcall(db: Database, actorId: number | null, at: string): void { const r = current(db); db.query('UPDATE rollcalls SET closed_at=$at WHERE id=$id').run({ $at: at, $id: r.id }); appendJournal(db, { at, actorId, action: 'rollcall.close', entity: `rollcall:${r.id}`, before: r, after: { ...r, closed_at: at } }); }
