import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';

// Optional relationships (§7): "John & Mary — spouses". Populated only when
// stated. Drives rooming, courtesy, shared preferences. Families remain the
// split unit — this is orthogonal.

export interface RelationshipRow {
  id: number;
  member_id: number;
  related_member_id: number;
  kind: string;
  note: string | null;
}

export function addRelationship(
  db: Database,
  memberId: number,
  relatedMemberId: number,
  kind: string,
  note: string | null,
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query('INSERT INTO relationships (member_id, related_member_id, kind, note) VALUES ($m, $r, $k, $n)')
    .run({ $m: memberId, $r: relatedMemberId, $k: kind, $n: note ?? null });
  const id = Number(res.lastInsertRowid);
  appendJournal(db, {
    at,
    actorId,
    action: 'relationship.add',
    entity: `relationship:${id}`,
    before: null,
    after: { id, member_id: memberId, related_member_id: relatedMemberId, kind, note: note ?? null },
  });
  return id;
}

export function listRelationships(db: Database): RelationshipRow[] {
  return db.query('SELECT * FROM relationships ORDER BY id').all() as RelationshipRow[];
}
