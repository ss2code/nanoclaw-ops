import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openPlanningDb } from '../scripts/db';
import { addMember, setTrip } from '../../trip-core/scripts/config';
import { setParticipation } from '../../trip-core/scripts/participation';
import { addPlace } from '../scripts/places';
import { addDay, addDestination, addItem, addLeg, addMeal, addStay, setStatus } from '../scripts/items';
import { validatePlan } from '../scripts/validate';

const SLOTS = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'night'];

/** A structurally-complete 1-night plan (two calendar days) for one traveller. */
function buildComplete(): Database {
  const db = openPlanningDb(':memory:');
  setTrip(db, { name: 'Goa', baseCurrency: 'INR', startDate: '2026-08-14', endDate: '2026-08-15' }, null, '2026-06-01T00:00:00');
  db.query('UPDATE trip SET total_budget = 5000000 WHERE id = 1').run();
  const arjun = addMember(db, { displayName: 'Arjun', joinedAt: '2026-06-01' }, null, '2026-06-01T00:00:00');
  setParticipation(db, arjun, 'on_trip', 'in', null, arjun, '2026-06-01T00:00:00');

  const goa = addPlace(db, { name: 'Goa', mapUrl: 'https://maps.example/goa' }, null, '2026-06-01T00:00:00');
  const blr = addPlace(db, { name: 'BLR', mapUrl: 'https://maps.example/blr' }, null, '2026-06-01T00:00:00');
  const commit = (t: any, id: number) => setStatus(db, t, id, 'committed', arjun, '2026-06-02T00:00:00');

  commit('destinations', addDestination(db, { placeId: goa, orderIndex: 0, nights: 1 }, null, '2026-06-01T00:00:00'));
  commit('legs', addLeg(db, { memberId: arjun, fromPlaceId: blr, toPlaceId: goa, mode: 'flight', direction: 'inbound', cost: 600000, bookingUrl: 'https://book/in' }, null, '2026-06-01T00:00:00'));
  commit('legs', addLeg(db, { memberId: arjun, fromPlaceId: goa, toPlaceId: blr, mode: 'flight', direction: 'outbound', cost: 600000, bookingUrl: 'https://book/out' }, null, '2026-06-01T00:00:00'));
  commit('stays', addStay(db, { placeId: goa, tier: 'boutique', checkIn: '2026-08-14', checkOut: '2026-08-15', nights: 1, costPerNight: 620000, breakfastIncluded: true, bookingUrl: 'https://book/stay' }, null, '2026-06-01T00:00:00'));

  for (const date of ['2026-08-14', '2026-08-15']) {
    const day = addDay(db, { date, basePlaceId: goa }, null, '2026-06-01T00:00:00');
    for (const slot of SLOTS) {
      commit('itinerary_items', addItem(db, { dayId: day, slot, placeId: goa, type: 'activity', title: `${slot} thing`, cost: 50000 }, null, '2026-06-01T00:00:00'));
    }
    // meals: 1 breakfast (included) + 2 lunch + 2 dinner
    commit('meals', addMeal(db, { dayId: day, slot: 'breakfast', includedInStay: true }, null, '2026-06-01T00:00:00'));
    commit('meals', addMeal(db, { dayId: day, slot: 'lunch', placeId: goa, cost: 50000, url: 'https://l1' }, null, '2026-06-01T00:00:00'));
    commit('meals', addMeal(db, { dayId: day, slot: 'lunch', placeId: goa, cost: 55000, url: 'https://l2' }, null, '2026-06-01T00:00:00'));
    commit('meals', addMeal(db, { dayId: day, slot: 'dinner', placeId: goa, cost: 80000, url: 'https://d1' }, null, '2026-06-01T00:00:00'));
    commit('meals', addMeal(db, { dayId: day, slot: 'dinner', placeId: goa, cost: 85000, url: 'https://d2' }, null, '2026-06-01T00:00:00'));
  }
  return db;
}

describe('plan validate — completeness gate (§8)', () => {
  test('a structurally-complete plan validates', () => {
    const r = validatePlan(buildComplete());
    expect(r).toEqual({ ok: true, missing: [] });
  });

  test('missing trip dates is flagged', () => {
    const db = buildComplete();
    db.query('UPDATE trip SET start_date = NULL WHERE id = 1').run();
    const r = validatePlan(db);
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => /date/i.test(m))).toBe(true);
  });

  test('no committed destination is flagged', () => {
    const db = buildComplete();
    db.query("UPDATE destinations SET status = 'candidate'").run();
    expect(validatePlan(db).missing.some((m) => /destination|route/i.test(m))).toBe(true);
  });

  test('a traveller missing an outbound leg is flagged', () => {
    const db = buildComplete();
    db.query("UPDATE legs SET status = 'candidate' WHERE direction = 'outbound'").run();
    expect(validatePlan(db).missing.some((m) => /outbound/i.test(m))).toBe(true);
  });

  test('an unresolved slot is flagged', () => {
    const db = buildComplete();
    db.query("UPDATE itinerary_items SET status = 'candidate' WHERE slot = 'evening'").run();
    expect(validatePlan(db).missing.some((m) => /evening/i.test(m))).toBe(true);
  });

  test('fewer than two committed dinner options is flagged', () => {
    const db = buildComplete();
    // drop one dinner to leave only 1
    db.query("DELETE FROM meals WHERE slot = 'dinner' AND id = (SELECT MAX(id) FROM meals WHERE slot='dinner')").run();
    expect(validatePlan(db).missing.some((m) => /dinner/i.test(m))).toBe(true);
  });

  test('a cost-less committed item is flagged', () => {
    const db = buildComplete();
    db.query("UPDATE itinerary_items SET cost = NULL WHERE slot = 'midday'").run();
    expect(validatePlan(db).missing.some((m) => /cost/i.test(m))).toBe(true);
  });

  test('a booking_required item without a deadline is flagged', () => {
    const db = buildComplete();
    db.query("UPDATE itinerary_items SET booking_required = 1, ticket_deadline = NULL WHERE slot = 'evening'").run();
    expect(validatePlan(db).missing.some((m) => /deadline|booking/i.test(m))).toBe(true);
  });

  test('a place without a map link is flagged', () => {
    const db = buildComplete();
    db.query("UPDATE places SET map_url = NULL WHERE name = 'Goa'").run();
    expect(validatePlan(db).missing.some((m) => /map/i.test(m))).toBe(true);
  });

  test('a stay not covering all nights is flagged', () => {
    const db = buildComplete();
    db.query("UPDATE stays SET status = 'candidate'").run();
    expect(validatePlan(db).missing.some((m) => /stay|night/i.test(m))).toBe(true);
  });
});
