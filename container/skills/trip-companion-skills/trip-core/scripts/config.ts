import type { Database } from 'bun:sqlite';
import { appendJournal, getMember } from './db';

// Identity + roster config for a trip. Written by the trip-setup flow and read
// by every feature skill. Every mutation is journaled — design §2 "Rights".
// (Extracted verbatim from trip-finance/scripts/config.ts; trip-finance now
// re-exports these. setTrip writes `status` exactly as before — the lifecycle
// `stage` column is managed separately by scripts/lifecycle.ts.)

export function setTrip(
  db: Database,
  trip: {
    name: string;
    baseCurrency?: string;
    startDate?: string;
    endDate?: string;
    defaultSplitRule?: string;
    status?: string;
  },
  actorId: number | null,
  at: string,
): void {
  const before = db.query('SELECT * FROM trip WHERE id = 1').get();
  db.query(
    `INSERT INTO trip (id, name, base_currency, start_date, end_date, default_split_rule, status)
     VALUES (1, $name, $cur, $start, $end, $rule, $status)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, base_currency = excluded.base_currency,
       start_date = excluded.start_date, end_date = excluded.end_date,
       default_split_rule = excluded.default_split_rule, status = excluded.status`,
  ).run({
    $name: trip.name,
    $cur: (trip.baseCurrency ?? 'INR').toUpperCase(),
    $start: trip.startDate ?? null,
    $end: trip.endDate ?? null,
    $rule: trip.defaultSplitRule ?? 'equal-all',
    $status: trip.status ?? 'active',
  });
  const after = db.query('SELECT * FROM trip WHERE id = 1').get();
  appendJournal(db, { at, actorId, action: 'config.trip.set', entity: 'trip:1', before, after });
}

export function addFamily(db: Database, name: string, actorId: number | null, at: string): number {
  const res = db.query('INSERT INTO families (name) VALUES ($name)').run({ $name: name });
  const id = Number(res.lastInsertRowid);
  appendJournal(db, {
    at, actorId, action: 'config.family.add', entity: `family:${id}`, before: null, after: { id, name },
  });
  return id;
}

export function addMember(
  db: Database,
  m: {
    displayName: string;
    aliases?: string[];
    familyId?: number | null;
    platformId?: string | null;
    joinedAt: string;
    excludedFromSplits?: boolean;
  },
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query(
      `INSERT INTO members (display_name, aliases, family_id, platform_id, joined_at, excluded_from_splits)
       VALUES ($name, $aliases, $family, $platform, $joined, $excluded)`,
    )
    .run({
      $name: m.displayName,
      $aliases: JSON.stringify(m.aliases ?? []),
      $family: m.familyId ?? null,
      $platform: m.platformId ?? null,
      $joined: m.joinedAt,
      $excluded: m.excludedFromSplits ? 1 : 0,
    });
  const id = Number(res.lastInsertRowid);
  appendJournal(db, {
    at, actorId, action: 'config.member.add', entity: `member:${id}`, before: null, after: getMember(db, id),
  });
  return id;
}

export function updateMember(
  db: Database,
  id: number,
  patch: Partial<{
    displayName: string;
    aliases: string[];
    familyId: number | null;
    platformId: string | null;
    joinedAt: string;
    leftAt: string | null;
    excludedFromSplits: boolean;
    upiId: string | null;
  }>,
  actorId: number | null,
  at: string,
): void {
  const before = getMember(db, id);
  if (!before) throw new Error(`member ${id} not found`);
  db.query(
    `UPDATE members SET
       display_name = $name, aliases = $aliases, family_id = $family, platform_id = $platform,
       joined_at = $joined, left_at = $left, excluded_from_splits = $excluded, upi_id = $upi
     WHERE id = $id`,
  ).run({
    $id: id,
    $name: patch.displayName ?? before.display_name,
    $aliases: patch.aliases ? JSON.stringify(patch.aliases) : before.aliases,
    $family: patch.familyId !== undefined ? patch.familyId : before.family_id,
    $platform: patch.platformId !== undefined ? patch.platformId : before.platform_id,
    $joined: patch.joinedAt ?? before.joined_at,
    $left: patch.leftAt !== undefined ? patch.leftAt : before.left_at,
    $excluded:
      patch.excludedFromSplits !== undefined ? (patch.excludedFromSplits ? 1 : 0) : before.excluded_from_splits,
    $upi: patch.upiId !== undefined ? patch.upiId : (before as any).upi_id ?? null,
  });
  appendJournal(db, {
    at, actorId, action: 'config.member.update', entity: `member:${id}`, before, after: getMember(db, id),
  });
}
