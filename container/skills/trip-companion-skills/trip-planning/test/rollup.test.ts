import { describe, expect, test } from 'bun:test';
import { openPlanningDb } from '../scripts/db';
import { addMember, setTrip } from '../../trip-core/scripts/config';
import { addPlace } from '../scripts/places';
import { addDay, addEvent, addHop, addItem, addLeg, addMeal, addStay, setStatus } from '../scripts/items';
import { rollup } from '../scripts/rollup';

// Hand-computed plan (all committed):
//   legs (per-member): Arjun ₹6,000 + Maya ₹4,000 = ₹10,000
//   shared: hop ₹1,000 + stay 3×₹2,000=₹6,000 + item ₹600 + meal ₹500 + event ₹900 = ₹9,000
//   + one USD item $50 (shared)
function seedPlan() {
  const db = openPlanningDb(':memory:');
  setTrip(db, { name: 'Goa', baseCurrency: 'INR', startDate: '2026-08-14', endDate: '2026-08-16' }, null, '2026-06-01T00:00:00');
  const arjun = addMember(db, { displayName: 'Arjun', joinedAt: '2026-06-01' }, null, '2026-06-01T00:00:00');
  const maya = addMember(db, { displayName: 'Maya', joinedAt: '2026-06-01' }, null, '2026-06-01T00:00:00');
  setTrip(db, { name: 'Goa', baseCurrency: 'INR' }, null, '2026-06-01T00:00:00');
  db.query('UPDATE trip SET total_budget = 5000000 WHERE id = 1').run();

  const goa = addPlace(db, { name: 'Goa' }, null, '2026-06-01T00:00:00');
  const blr = addPlace(db, { name: 'BLR' }, null, '2026-06-01T00:00:00');
  const commit = (t: any, id: number) => setStatus(db, t, id, 'committed', 1, '2026-06-02T00:00:00');

  commit('legs', addLeg(db, { memberId: arjun, fromPlaceId: blr, toPlaceId: goa, mode: 'flight', direction: 'inbound', cost: 600000 }, null, '2026-06-01T00:00:00'));
  commit('legs', addLeg(db, { memberId: maya, fromPlaceId: blr, toPlaceId: goa, mode: 'flight', direction: 'inbound', cost: 400000 }, null, '2026-06-01T00:00:00'));
  commit('transport_hops', addHop(db, { fromPlaceId: blr, toPlaceId: goa, mode: 'taxi', cost: 100000 }, null, '2026-06-01T00:00:00'));
  commit('stays', addStay(db, { placeId: goa, checkIn: '2026-08-14', checkOut: '2026-08-17', nights: 3, costPerNight: 200000 }, null, '2026-06-01T00:00:00'));
  const day = addDay(db, { date: '2026-08-15', basePlaceId: goa }, null, '2026-06-01T00:00:00');
  commit('itinerary_items', addItem(db, { dayId: day, slot: 'midday', type: 'activity', title: 'Fort', cost: 60000 }, null, '2026-06-01T00:00:00'));
  commit('meals', addMeal(db, { dayId: day, slot: 'lunch', cost: 50000 }, null, '2026-06-01T00:00:00'));
  commit('events', addEvent(db, { date: '2026-08-15', title: 'Festival', cost: 90000 }, null, '2026-06-01T00:00:00'));
  // a USD shared item on the same day
  commit('itinerary_items', addItem(db, { dayId: day, slot: 'evening', type: 'activity', title: 'Cruise', cost: 5000, currency: 'USD' }, null, '2026-06-01T00:00:00'));
  return { db, arjun, maya, day };
}

describe('cost rollups (§8 must-have 11)', () => {
  test('byCurrency totals committed cost-bearing rows, per currency', () => {
    const { db } = seedPlan();
    const r = rollup(db);
    expect(r.byCurrency).toEqual({ INR: 1_900_000, USD: 5_000 });
  });

  test('perPerson splits shared cost equally and adds own legs', () => {
    const { db, arjun, maya } = seedPlan();
    const r = rollup(db);
    // shared INR = 9,000 → 4,500 each; + own legs
    expect(r.perPerson[arjun].INR).toBe(600_000 + 450_000);
    expect(r.perPerson[maya].INR).toBe(400_000 + 450_000);
    // shared USD = $50 → $25 each, no per-person legs in USD
    expect(r.perPerson[arjun].USD).toBe(2_500);
    expect(r.perPerson[maya].USD).toBe(2_500);
    // per-person sums reconcile to the totals
    const sumInr = r.perPerson[arjun].INR + r.perPerson[maya].INR;
    expect(sumInr).toBe(r.byCurrency.INR);
  });

  test('perDay totals items + meals for the day, per currency', () => {
    const { db, day } = seedPlan();
    const r = rollup(db);
    expect(r.perDay[day]).toEqual({ INR: 110_000, USD: 5_000 });
  });

  test('budget compares the base-currency total to total_budget; flags non-base spend', () => {
    const { db } = seedPlan();
    const r = rollup(db);
    expect(r.budget).not.toBeNull();
    expect(r.budget!.base).toBe('INR');
    expect(r.budget!.totalBudget).toBe(5_000_000);
    expect(r.budget!.baseTotal).toBe(1_900_000);
    expect(r.budget!.withinBudget).toBe(true);
    expect(r.budget!.otherCurrencies).toEqual(['USD']);
  });

  test('candidate rows are excluded; only committed counts toward the budget total', () => {
    const { db } = seedPlan();
    const goa = db.query("SELECT id FROM places WHERE name='Goa'").get() as { id: number };
    // an uncommitted (candidate) big-ticket item must not move the total
    addItem(db, { dayId: 1, slot: 'night', type: 'activity', title: 'helicopter', cost: 10_000_000 }, null, '2026-06-03T00:00:00');
    const r = rollup(db);
    expect(r.byCurrency.INR).toBe(1_900_000);
  });
});
