import { describe, expect, test } from 'bun:test';
import { openCoreDb } from '../scripts/db';
import { setTrip, addMember } from '../scripts/config';
import { setParticipation } from '../scripts/participation';
import { addChecklistItem, checklistBoard, claimGear, confirmItem, readinessDue, seedPacking, seedReadiness } from '../scripts/checklists';
import { openRollcall, checkIn, rollcallStatus, closeRollcall } from '../scripts/rollcall';
import { addDiary, diaryEntries } from '../scripts/diary';
import { indexAsset, listAssets } from '../scripts/assets';

function seed() { const db = openCoreDb(':memory:'); setTrip(db, { name: 'Goa', startDate: '2026-08-14' }, null, '2026-01-01T00:00:00Z'); const a = addMember(db, { displayName: 'A', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00Z'); const b = addMember(db, { displayName: 'B', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00Z'); return { db, a, b }; }

describe('lifecycle expansion', () => {
  test('packing is idempotent; gear claims are compare-and-set; readiness lists only active gaps', () => {
    const { db, a, b } = seed();
    seedPacking(db, 'beach', a, '2026-08-01T00:00:00Z'); seedPacking(db, 'beach', a, '2026-08-01T00:00:00Z');
    expect(checklistBoard(db, 'packing')).toHaveLength(12);
    const gear = addChecklistItem(db, 'gear', { label: 'Speaker' }, a, '2026-08-01T00:00:00Z'); claimGear(db, gear, a, false, a, '2026-08-01T00:00:00Z');
    expect(() => claimGear(db, gear, b, false, b, '2026-08-01T00:00:00Z')).toThrow(/already claimed by A/);
    const ids = seedReadiness(db, a, '2026-08-01T00:00:00Z'); expect(ids).toHaveLength(5);
    setParticipation(db, b, 'start_trip', 'out', null, a, '2026-08-01T00:00:00Z'); confirmItem(db, ids[1], a, a, '2026-08-11T00:00:00Z');
    const due = readinessDue(db, '2026-08-12T00:00:00Z'); expect(due.map((x) => x.label)).toEqual(['Book airport transfers / cabs', 'Confirm ID documents valid & packed', 'Share meds / allergy notes if any']);
    expect(due.find((x) => x.id === ids[1]).missing).toEqual([]);
  });
  test('roll-call excludes out members; diary and day/place asset filters persist', () => {
    const { db, a, b } = seed(); setParticipation(db, b, 'on_trip', 'out', null, a, '2026-08-14T00:00:00Z');
    openRollcall(db, 'Gate', a, '2026-08-14T00:00:00Z'); checkIn(db, a, 'at security', a, '2026-08-14T00:01:00Z');
    expect(rollcallStatus(db)).toMatchObject({ complete: true, missing: [] }); closeRollcall(db, a, '2026-08-14T00:02:00Z');
    addDiary(db, { date: '2026-08-14', entry: 'Dolphins!', memberId: a }, a, '2026-08-14T20:00:00Z'); expect(diaryEntries(db, '2026-08-14')[0].entry).toBe('Dolphins!');
    indexAsset(db, { kind: 'photo', path: 'assets/a.jpg', dayDate: '2026-08-14', placeId: 9, addedBy: a }, '2026-08-14T20:00:00Z');
    expect(listAssets(db, { dayDate: '2026-08-14', placeId: 9 })).toHaveLength(1);
  });
});
