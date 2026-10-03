import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';

const TITLES: Record<string, string> = { gear: 'Shared gear', packing: 'Packing', readiness: 'Readiness' };
export const TEMPLATES: Record<string, string[]> = {
  beach: ['Swimwear', 'Sunscreen', 'Hat', 'Sunglasses', 'Flip-flops', 'Light layers', 'Reusable water bottle', 'Beach towel', 'Insect repellent', 'Waterproof phone pouch', 'Book', 'Power bank'],
  hill: ['Warm layers', 'Rain jacket', 'Hiking shoes', 'Daypack', 'Hat', 'Sunscreen', 'Reusable water bottle', 'Torch', 'Power bank', 'Insect repellent', 'Gloves', 'Camera'],
  city: ['Comfortable walking shoes', 'Light jacket', 'Day bag', 'Reusable water bottle', 'Power bank', 'Travel adapter', 'Sunglasses', 'Umbrella', 'Wallet', 'Camera', 'Medication', 'Notebook'],
};

function checklist(db: Database, kind: string, actorId: number | null, at: string): number {
  if (!TITLES[kind]) throw new Error(`unknown checklist kind ${kind}`);
  const existing = db.query('SELECT id FROM checklists WHERE kind = $kind').get({ $kind: kind }) as { id: number } | null;
  if (existing) return existing.id;
  const id = Number(db.query('INSERT INTO checklists (kind, title, created_at, created_by) VALUES ($kind, $title, $at, $by)').run({ $kind: kind, $title: TITLES[kind], $at: at, $by: actorId }).lastInsertRowid);
  appendJournal(db, { at, actorId, action: 'checklist.create', entity: `checklist:${id}`, before: null, after: { kind } });
  return id;
}

export function addChecklistItem(db: Database, kind: string, item: { label: string; note?: string | null; perMember?: boolean; dueDate?: string | null }, actorId: number | null, at: string): number {
  const checklistId = checklist(db, kind, actorId, at);
  const row = db.query('SELECT id FROM checklist_items WHERE checklist_id = $c AND label = $l').get({ $c: checklistId, $l: item.label }) as { id: number } | null;
  if (row) return row.id;
  const id = Number(db.query(`INSERT INTO checklist_items (checklist_id, label, due_date, per_member, note, created_at) VALUES ($c, $l, $due, $per, $note, $at)`).run({ $c: checklistId, $l: item.label, $due: item.dueDate ?? null, $per: item.perMember ? 1 : 0, $note: item.note ?? null, $at: at }).lastInsertRowid);
  appendJournal(db, { at, actorId, action: 'checklist.add', entity: `checklist_item:${id}`, before: null, after: { kind, label: item.label } });
  return id;
}

export function seedPacking(db: Database, template: string, actorId: number | null, at: string): number[] {
  const labels = TEMPLATES[template]; if (!labels) throw new Error('--template must be beach, hill, or city');
  const ids = labels.map((label) => addChecklistItem(db, 'packing', { label }, actorId, at));
  addChecklistItem(db, 'gear', { label: 'First-aid kit' }, actorId, at);
  return ids;
}

const READINESS: [number, string, boolean][] = [[7, 'Book airport transfers / cabs', false], [3, 'Confirm ID documents valid & packed', true], [2, 'Share meds / allergy notes if any', true], [1, 'Online check-in', true], [1, 'Download offline maps for destination(s)', false]];
function dateMinus(date: string, days: number): string { const d = new Date(`${date.slice(0, 10)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); }
export function seedReadiness(db: Database, actorId: number | null, at: string): number[] {
  const trip = db.query('SELECT start_date FROM trip WHERE id = 1').get() as { start_date: string | null } | null;
  if (!trip?.start_date) throw new Error('trip.start_date is required before readiness seed');
  const c = checklist(db, 'readiness', actorId, at); const ids: number[] = [];
  for (const [offset, label, perMember] of READINESS) {
    const due = dateMinus(trip.start_date, offset);
    const existing = db.query('SELECT id FROM checklist_items WHERE checklist_id=$c AND label=$l').get({ $c: c, $l: label }) as { id: number } | null;
    if (existing) { db.query('UPDATE checklist_items SET due_date=$due, per_member=$per WHERE id=$id').run({ $due: due, $per: perMember ? 1 : 0, $id: existing.id }); ids.push(existing.id); }
    else ids.push(addChecklistItem(db, 'readiness', { label, dueDate: due, perMember }, actorId, at));
  }
  appendJournal(db, { at, actorId, action: 'checklist.readiness.seed', entity: `checklist:${c}`, before: null, after: { start_date: trip.start_date } });
  return ids;
}

export function claimGear(db: Database, itemId: number, memberId: number, force: boolean, actorId: number | null, at: string): void {
  const before = db.query('SELECT * FROM checklist_items WHERE id=$id').get({ $id: itemId }) as any;
  if (!before) throw new Error(`checklist item ${itemId} not found`);
  if (force && before.claimed_by === memberId) return;
  const r = db.query('UPDATE checklist_items SET claimed_by=$m WHERE id=$id AND claimed_by IS NULL').run({ $m: memberId, $id: itemId });
  if (r.changes === 0) { const owner = db.query('SELECT display_name FROM members WHERE id=$id').get({ $id: before.claimed_by }) as { display_name: string } | null; throw new Error(`already claimed by ${owner?.display_name ?? `member#${before.claimed_by}`}`); }
  appendJournal(db, { at, actorId, action: 'checklist.claim', entity: `checklist_item:${itemId}`, before, after: { claimed_by: memberId } });
}
export function unclaimGear(db: Database, itemId: number, memberId: number, force: boolean, actorId: number | null, at: string): void {
  const before = db.query('SELECT * FROM checklist_items WHERE id=$id').get({ $id: itemId }) as any;
  if (!before) throw new Error(`checklist item ${itemId} not found`);
  if (!force && before.claimed_by !== memberId) throw new Error('only the claimer may unclaim (or pass --force)');
  db.query('UPDATE checklist_items SET claimed_by=NULL WHERE id=$id').run({ $id: itemId });
  appendJournal(db, { at, actorId, action: 'checklist.unclaim', entity: `checklist_item:${itemId}`, before, after: { claimed_by: null } });
}
export function confirmItem(db: Database, itemId: number, memberId: number, actorId: number | null, at: string): void {
  const item = db.query('SELECT * FROM checklist_items WHERE id=$id').get({ $id: itemId }) as any;
  if (!item) throw new Error(`checklist item ${itemId} not found`); if (!item.per_member) throw new Error('this is a group-level item; use readiness done');
  db.query(`INSERT INTO checklist_confirmations (item_id, member_id, at) VALUES ($i,$m,$at) ON CONFLICT(item_id,member_id) DO UPDATE SET at=excluded.at`).run({ $i: itemId, $m: memberId, $at: at });
  appendJournal(db, { at, actorId, action: 'checklist.confirm', entity: `checklist_item:${itemId}`, before: null, after: { member_id: memberId } });
}
export function doneItem(db: Database, itemId: number, actorId: number | null, at: string): void {
  const before = db.query('SELECT * FROM checklist_items WHERE id=$id').get({ $id: itemId }) as any;
  if (!before) throw new Error(`checklist item ${itemId} not found`); if (before.per_member) throw new Error('per-member item requires individual confirmations');
  db.query("UPDATE checklist_items SET status='done' WHERE id=$id").run({ $id: itemId });
  appendJournal(db, { at, actorId, action: 'checklist.done', entity: `checklist_item:${itemId}`, before, after: { status: 'done' } });
}
export function dropItem(db: Database, itemId: number, actorId: number | null, at: string): void { const before = db.query('SELECT * FROM checklist_items WHERE id=$id').get({ $id: itemId }); if (!before) throw new Error(`checklist item ${itemId} not found`); db.query("UPDATE checklist_items SET status='dropped' WHERE id=$id").run({ $id: itemId }); appendJournal(db, { at, actorId, action: 'checklist.drop', entity: `checklist_item:${itemId}`, before, after: { status: 'dropped' } }); }
export function checklistBoard(db: Database, kind: string): any[] { return db.query(`SELECT i.*, m.display_name AS claimed_name FROM checklist_items i JOIN checklists c ON c.id=i.checklist_id LEFT JOIN members m ON m.id=i.claimed_by WHERE c.kind=$kind ORDER BY CASE WHEN i.claimed_by IS NULL THEN 0 ELSE 1 END, i.id`).all({ $kind: kind }) as any[]; }
export function readinessDue(db: Database, at: string): any[] {
  const rows = db.query(`SELECT i.* FROM checklist_items i JOIN checklists c ON c.id=i.checklist_id WHERE c.kind='readiness' AND i.status='open' AND i.due_date <= $at ORDER BY i.due_date, i.id`).all({ $at: at.slice(0, 10) }) as any[];
  const active = db.query(`SELECT m.id,m.display_name FROM members m LEFT JOIN stage_participation p ON p.member_id=m.id AND p.stage='start_trip' WHERE m.left_at IS NULL AND COALESCE(p.status,'in') != 'out' ORDER BY m.id`).all() as any[];
  return rows.map((r) => ({ ...r, missing: r.per_member ? active.filter((m) => !(db.query('SELECT 1 FROM checklist_confirmations WHERE item_id=$i AND member_id=$m').get({ $i: r.id, $m: m.id }))).map((m) => ({ memberId: m.id, name: m.display_name })) : [] }));
}
