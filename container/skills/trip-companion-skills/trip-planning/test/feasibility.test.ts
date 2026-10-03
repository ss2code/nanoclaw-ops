import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openPlanningDb } from '../scripts/db';
import { addMember, setTrip } from '../../trip-core/scripts/config';
import { addPlace } from '../scripts/places';
import { addDay, addItem, addStay, setStatus } from '../scripts/items';
import { checkPlan } from '../scripts/feasibility';

function base(): { db: Database; goa: number; day: number } {
  const db = openPlanningDb(':memory:');
  setTrip(db, { name: 'Goa', baseCurrency: 'INR', startDate: '2026-08-14', endDate: '2026-08-15' }, null, '2026-06-01T00:00:00');
  db.query('UPDATE trip SET total_budget = 10000000 WHERE id = 1').run();
  addMember(db, { displayName: 'Arjun', joinedAt: '2026-06-01' }, null, '2026-06-01T00:00:00');
  const goa = addPlace(db, { name: 'Goa', mapUrl: 'https://m/goa' }, null, '2026-06-01T00:00:00');
  const day = addDay(db, { date: '2026-08-14', basePlaceId: goa }, null, '2026-06-01T00:00:00');
  return { db, goa, day };
}
const commit = (db: Database, t: any, id: number) => setStatus(db, t, id, 'committed', 1, '2026-06-02T00:00:00');

describe('plan check — feasibility (§8)', () => {
  test('a viable plan returns no errors', () => {
    const { db, goa, day } = base();
    commit(db, 'stays', addStay(db, { placeId: goa, checkIn: '2026-08-14', checkOut: '2026-08-15', nights: 1, costPerNight: 200000 }, null, '2026-06-01T00:00:00'));
    commit(db, 'itinerary_items', addItem(db, { dayId: day, slot: 'midday', placeId: goa, type: 'activity', title: 'Fort', start: '10:00', end: '12:00', cost: 60000 }, null, '2026-06-01T00:00:00'));
    commit(db, 'itinerary_items', addItem(db, { dayId: day, slot: 'afternoon', placeId: goa, type: 'activity', title: 'Lunch spot', start: '13:00', end: '14:00', travelMinutes: 20, cost: 50000 }, null, '2026-06-01T00:00:00'));
    const r = checkPlan(db, { now: '2026-06-10' });
    expect(r.errors).toEqual([]);
  });

  test('a connection that cannot be made in time is a hard error', () => {
    const { db, goa, day } = base();
    commit(db, 'stays', addStay(db, { placeId: goa, checkIn: '2026-08-14', checkOut: '2026-08-15', nights: 1, costPerNight: 200000 }, null, '2026-06-01T00:00:00'));
    commit(db, 'itinerary_items', addItem(db, { dayId: day, slot: 'midday', placeId: goa, type: 'activity', title: 'Chapora Fort', start: '10:00', end: '17:00', cost: 60000 }, null, '2026-06-01T00:00:00'));
    // cruise at 17:30 across town, 40m travel → only 30m gap → impossible
    commit(db, 'itinerary_items', addItem(db, { dayId: day, slot: 'evening', placeId: goa, type: 'activity', title: 'Sunset cruise', start: '17:30', end: '19:00', travelMinutes: 40, cost: 90000 }, null, '2026-06-01T00:00:00'));
    const r = checkPlan(db, { now: '2026-06-10' });
    expect(r.errors.some((e) => /cruise/i.test(e.message) && e.day === day)).toBe(true);
  });

  test('a tight-but-makeable connection is a soft warning, not an error', () => {
    const { db, goa, day } = base();
    commit(db, 'stays', addStay(db, { placeId: goa, checkIn: '2026-08-14', checkOut: '2026-08-15', nights: 1, costPerNight: 200000 }, null, '2026-06-01T00:00:00'));
    commit(db, 'itinerary_items', addItem(db, { dayId: day, slot: 'midday', placeId: goa, type: 'activity', title: 'Fort', start: '10:00', end: '12:00', cost: 60000 }, null, '2026-06-01T00:00:00'));
    // 12:50 start, 40m travel → 10m slack (>=0 but < 15 threshold) → warning
    commit(db, 'itinerary_items', addItem(db, { dayId: day, slot: 'afternoon', placeId: goa, type: 'activity', title: 'Beach', start: '12:50', end: '14:00', travelMinutes: 40, cost: 0 }, null, '2026-06-01T00:00:00'));
    const r = checkPlan(db, { now: '2026-06-10' });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /tight/i.test(w.message))).toBe(true);
  });

  test('over-budget is a hard error', () => {
    const { db, goa, day } = base();
    db.query('UPDATE trip SET total_budget = 100000 WHERE id = 1').run(); // ₹1,000 cap
    commit(db, 'stays', addStay(db, { placeId: goa, checkIn: '2026-08-14', checkOut: '2026-08-15', nights: 1, costPerNight: 200000 }, null, '2026-06-01T00:00:00')); // ₹2,000 > cap
    const r = checkPlan(db, { now: '2026-06-10' });
    expect(r.errors.some((e) => /budget/i.test(e.message))).toBe(true);
  });

  test('a passed booking deadline is a hard error', () => {
    const { db, goa, day } = base();
    commit(db, 'stays', addStay(db, { placeId: goa, checkIn: '2026-08-14', checkOut: '2026-08-15', nights: 1, costPerNight: 200000 }, null, '2026-06-01T00:00:00'));
    commit(db, 'itinerary_items', addItem(db, { dayId: day, slot: 'evening', placeId: goa, type: 'activity', title: 'Cruise', cost: 90000, bookingRequired: true, ticketDeadline: '2026-05-01' }, null, '2026-06-01T00:00:00'));
    const r = checkPlan(db, { now: '2026-06-10' });
    expect(r.errors.some((e) => /deadline/i.test(e.message) && /cruise/i.test(e.message))).toBe(true);
  });

  test('an uncovered night is a hard error', () => {
    const { db, goa } = base();
    // no committed stay at all → the 1 night is uncovered
    const r = checkPlan(db, { now: '2026-06-10' });
    expect(r.errors.some((e) => /night/i.test(e.message))).toBe(true);
  });
});
