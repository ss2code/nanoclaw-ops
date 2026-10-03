import { describe, expect, test } from 'bun:test';
import { openPlanningDb } from '../scripts/db';
import { setTrip } from '../../trip-core/scripts/config';
import { addDay, addItem, setStatus } from '../scripts/items';
import { checkPlan } from '../scripts/feasibility';
import { addPlace, setPlace } from '../scripts/places';

describe('improvement-pack planning checks', () => {
  test('opening hours and a pace cap are deterministic feasibility results', () => {
    const db = openPlanningDb(':memory:'); setTrip(db, { name: 'T', startDate: '2026-08-01', endDate: '2026-08-02' }, null, '2026-01-01T00:00:00Z');
    const place = addPlace(db, { name: 'Museum' }, null, '2026-01-01T00:00:00Z'); setPlace(db, place, { openHours: '09:00-17:00' }, null, '2026-01-01T00:00:00Z');
    const day = addDay(db, { date: '2026-08-01' }, null, '2026-01-01T00:00:00Z'); const item = addItem(db, { dayId: day, slot: 'morning', title: 'Visit', placeId: place, start: '18:00', end: '19:00', travelMinutes: 400 }, null, '2026-01-01T00:00:00Z'); setStatus(db, 'itinerary_items', item, 'committed', null, '2026-01-01T00:00:00Z');
    db.query('UPDATE trip SET pace_cap_minutes=300 WHERE id=1').run(); const result = checkPlan(db, { now: '2026-07-01' });
    expect(result.errors.some((x) => x.message.includes('outside Museum hours'))).toBe(true); expect(result.warnings.some((x) => x.message.includes('pace cap'))).toBe(true);
  });
  test('alternate is always candidate and inherits primary day/slot', () => {
    const db = openPlanningDb(':memory:'); setTrip(db, { name: 'T' }, null, '2026-01-01T00:00:00Z'); const day = addDay(db, { date: '2026-08-01' }, null, '2026-01-01T00:00:00Z'); const primary = addItem(db, { dayId: day, slot: 'morning', title: 'Primary' }, null, '2026-01-01T00:00:00Z'); const alt = addItem(db, { dayId: 999, slot: 'night', title: 'Alt', alternateForItemId: primary }, null, '2026-01-01T00:00:00Z');
    expect(db.query('SELECT day_id,slot,status FROM itinerary_items WHERE id=$id').get({ $id: alt })).toEqual({ day_id: day, slot: 'morning', status: 'candidate' });
  });
});
