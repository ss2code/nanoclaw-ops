import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';

// One roster, per-stage participation (§12). planning ≠ on-trip. The same
// member can be `in` for planning and `out` for the trip, or vice-versa.

export interface ParticipationRow {
  member_id: number;
  display_name: string;
  platform_id: string | null;
  status: string;
  note: string | null;
}

/** Upsert a member's participation for a stage. Journaled. */
export function setParticipation(
  db: Database,
  memberId: number,
  stage: string,
  status: string,
  note: string | null,
  actorId: number | null,
  at: string,
): void {
  const before = db
    .query('SELECT member_id, stage, status, note FROM stage_participation WHERE member_id = $m AND stage = $s')
    .get({ $m: memberId, $s: stage });
  db.query(
    `INSERT INTO stage_participation (member_id, stage, status, note)
     VALUES ($m, $s, $st, $n)
     ON CONFLICT(member_id, stage) DO UPDATE SET status = excluded.status, note = excluded.note`,
  ).run({ $m: memberId, $s: stage, $st: status, $n: note ?? null });
  appendJournal(db, {
    at,
    actorId,
    action: 'participation.set',
    entity: `member:${memberId}@${stage}`,
    before,
    after: { member_id: memberId, stage, status, note: note ?? null },
  });
}

/** All members with a participation row for `stage`, joined to their display names, ordered by member id. */
export function participantsForStage(db: Database, stage: string): ParticipationRow[] {
  return db
    .query(
      `SELECT p.member_id, m.display_name, m.platform_id, p.status, p.note
       FROM stage_participation p JOIN members m ON m.id = p.member_id
       WHERE p.stage = $s ORDER BY p.member_id`,
    )
    .all({ $s: stage }) as ParticipationRow[];
}
