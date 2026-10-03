import { describe, expect, test } from 'bun:test';
import { openPlanningDb } from '../scripts/db';
import { addMember, setTrip } from '../../trip-core/scripts/config';
import { addPlace } from '../scripts/places';
import { addDay, addDestination, addItem, addLeg, addStay, setStatus } from '../scripts/items';
import { WATERMARK, exportPlan, snapshotPlan } from '../scripts/export';

function seed() {
  const db = openPlanningDb(':memory:');
  setTrip(db, { name: 'Goa 2026', baseCurrency: 'INR', startDate: '2026-08-14', endDate: '2026-08-15' }, null, '2026-06-01T00:00:00');
  db.query('UPDATE trip SET total_budget = 5000000 WHERE id = 1').run();
  const arjun = addMember(db, { displayName: 'Arjun', joinedAt: '2026-06-01' }, null, '2026-06-01T00:00:00');
  const goa = addPlace(db, { name: 'Vagator', mapUrl: 'https://maps.example/vagator' }, null, '2026-06-01T00:00:00');
  const blr = addPlace(db, { name: 'BLR' }, null, '2026-06-01T00:00:00');
  const commit = (t: any, id: number) => setStatus(db, t, id, 'committed', arjun, '2026-06-02T00:00:00');
  commit('destinations', addDestination(db, { placeId: goa, orderIndex: 0, nights: 1 }, null, '2026-06-01T00:00:00'));
  commit('legs', addLeg(db, { memberId: arjun, fromPlaceId: blr, toPlaceId: goa, mode: 'flight', direction: 'inbound', cost: 600000, bookingUrl: 'https://book/in' }, null, '2026-06-01T00:00:00'));
  commit('stays', addStay(db, { placeId: goa, tier: 'boutique', checkIn: '2026-08-14', checkOut: '2026-08-15', nights: 1, costPerNight: 620000 }, null, '2026-06-01T00:00:00'));
  const day = addDay(db, { date: '2026-08-14', basePlaceId: goa }, null, '2026-06-01T00:00:00');
  commit('itinerary_items', addItem(db, { dayId: day, slot: 'evening', placeId: goa, type: 'activity', title: 'Sunset cruise', cost: 90000, bookingRequired: true, ticketDeadline: '2026-08-13', infoUrl: 'https://cruise' }, null, '2026-06-01T00:00:00'));
  return { db };
}

describe('plan export (§18)', () => {
  test('exportPlan renders a self-contained HTML plan with the watermark', () => {
    const { db } = seed();
    const html = exportPlan(db);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Goa 2026');
    expect(html).toContain('Vagator'); // a place name
    expect(html).toContain('Sunset cruise'); // an itinerary item
    expect(html).toContain('2026-08-14'); // a day
    expect(html).toContain('₹6,000.00'); // a cost rollup figure (the inbound leg, formatted)
    expect(html).toContain(WATERMARK);
    expect(html).toContain('https://maps.example/vagator'); // every place linked
  });

  test('the bookings ledger lists must-book items with their deadline', () => {
    const { db } = seed();
    const html = exportPlan(db);
    expect(html).toContain('2026-08-13'); // ticket deadline
    expect(html.toLowerCase()).toContain('book');
  });

  test('draft export carries the DRAFT — not locked watermark', () => {
    const { db } = seed();
    const html = exportPlan(db, { draft: true });
    expect(html).toContain('DRAFT — not locked');
  });

  test('snapshotPlan freezes the committed set into plan_versions and bumps the version', () => {
    const { db } = seed();
    const v1 = snapshotPlan(db, true, '2026-06-10T00:00:00');
    expect(v1).toBe(1);
    const v2 = snapshotPlan(db, true, '2026-06-11T00:00:00');
    expect(v2).toBe(2);
    const row = db.query('SELECT validated, summary_json FROM plan_versions WHERE version = 1').get() as any;
    expect(row.validated).toBe(1);
    expect(JSON.parse(row.summary_json).destinations.length).toBe(1);
  });
});
