import { describe, expect, test } from 'bun:test';
import { openPlanningDb } from '../scripts/db';
import { addMember, setTrip } from '../../trip-core/scripts/config';
import { addPlace, getPlace, parseGoogleMapsLatLng, setReviewDigest } from '../scripts/places';
import {
  addDay,
  addDestination,
  addEvent,
  addItem,
  addLeg,
  addMeal,
  addStay,
  addHop,
  setStatus,
} from '../scripts/items';

function seed() {
  const db = openPlanningDb(':memory:');
  setTrip(db, { name: 'Goa 2026', baseCurrency: 'INR', startDate: '2026-08-14', endDate: '2026-08-17' }, null, '2026-06-01T00:00:00');
  addMember(db, { displayName: 'Arjun', joinedAt: '2026-06-01' }, null, '2026-06-01T00:00:00'); // id 1
  return db;
}

describe('places', () => {
  test('parses Google Maps coordinates and lets explicit lat/lng override URL parsing', () => {
    expect(parseGoogleMapsLatLng('https://www.google.com/maps/place/Portree/@57.4125,-6.1960,14z')).toEqual({ lat: 57.4125, lng: -6.196 });
    expect(parseGoogleMapsLatLng('https://maps.google.com/?q=55.9533,-3.1883')).toEqual({ lat: 55.9533, lng: -3.1883 });
    const db = seed();
    const p = addPlace(db, { name: 'Portree', mapUrl: 'https://www.google.com/maps/place/Portree/@57.4125,-6.1960,14z', lat: 1, lng: 2 }, null, '2026-06-01T00:00:00');
    expect(getPlace(db, p)).toMatchObject({ lat: 1, lng: 2 });
  });

  test('addPlace + getPlace; review digest is set separately', () => {
    const db = seed();
    const p = addPlace(db, { name: 'Vagator Beach House', kind: 'stay', mapUrl: 'https://maps.example/vbh' }, null, '2026-06-01T00:00:00');
    expect(getPlace(db, p)).toMatchObject({ name: 'Vagator Beach House', kind: 'stay', map_url: 'https://maps.example/vbh' });
    setReviewDigest(db, p, 4.6, 1280, 'Guests love the quiet beachfront setting.', null, '2026-06-01T01:00:00');
    expect(getPlace(db, p)).toMatchObject({ rating: 4.6, review_count: 1280 });
  });
});

describe('plan items — status + currency defaults', () => {
  test('every item type defaults status=candidate and currency=base when omitted', () => {
    const db = seed();
    const goa = addPlace(db, { name: 'Goa' }, null, '2026-06-01T00:00:00');
    const blr = addPlace(db, { name: 'Bengaluru airport' }, null, '2026-06-01T00:00:00');

    const dest = addDestination(db, { placeId: goa, orderIndex: 0, nights: 3, rationale: 'beaches' }, null, '2026-06-01T00:00:00');
    const leg = addLeg(db, { memberId: 1, fromPlaceId: blr, toPlaceId: goa, mode: 'flight', direction: 'inbound', cost: 650000 }, null, '2026-06-01T00:00:00');
    const hop = addHop(db, { fromPlaceId: blr, toPlaceId: goa, mode: 'taxi', travelMinutes: 40 }, null, '2026-06-01T00:00:00');
    const stay = addStay(db, { destinationId: dest, placeId: goa, tier: 'boutique', checkIn: '2026-08-14', checkOut: '2026-08-17', nights: 3, costPerNight: 620000, breakfastIncluded: true }, null, '2026-06-01T00:00:00');
    const day = addDay(db, { date: '2026-08-15', basePlaceId: goa, theme: 'beaches & a fort' }, null, '2026-06-01T00:00:00');
    const item = addItem(db, { dayId: day, slot: 'midday', placeId: goa, type: 'activity', title: 'Chapora Fort', cost: 60000, bookingRequired: false }, null, '2026-06-01T00:00:00');
    const meal = addMeal(db, { dayId: day, slot: 'lunch', placeId: goa, cost: 50000 }, null, '2026-06-01T00:00:00');
    const ev = addEvent(db, { date: '2026-08-15', placeId: goa, title: 'Beach festival', kind: 'attend' }, null, '2026-06-01T00:00:00');

    const statusCur = (t: string, id: number) => db.query(`SELECT status, currency FROM ${t} WHERE id = $id`).get({ $id: id }) as any;
    const statusOf = (t: string, id: number) => (db.query(`SELECT status FROM ${t} WHERE id = $id`).get({ $id: id }) as any).status;
    // destinations carry no cost/currency (place + nights only)
    expect(statusOf('destinations', dest)).toBe('candidate');
    expect(statusCur('legs', leg)).toEqual({ status: 'candidate', currency: 'INR' });
    expect(statusCur('transport_hops', hop)).toEqual({ status: 'candidate', currency: 'INR' });
    expect(statusCur('stays', stay)).toEqual({ status: 'candidate', currency: 'INR' });
    expect(statusCur('itinerary_items', item)).toEqual({ status: 'candidate', currency: 'INR' });
    expect(statusCur('meals', meal)).toEqual({ status: 'candidate', currency: 'INR' });
    expect(statusCur('events', ev)).toEqual({ status: 'candidate', currency: 'INR' });
  });

  test('explicit currency is preserved', () => {
    const db = seed();
    const p = addPlace(db, { name: 'X' }, null, '2026-06-01T00:00:00');
    const leg = addLeg(db, { memberId: 1, toPlaceId: p, mode: 'flight', direction: 'inbound', cost: 20000, currency: 'USD' }, null, '2026-06-01T00:00:00');
    expect((db.query('SELECT currency FROM legs WHERE id = $id').get({ $id: leg }) as any).currency).toBe('USD');
  });

  test('setStatus transitions an item and journals it', () => {
    const db = seed();
    const p = addPlace(db, { name: 'Goa' }, null, '2026-06-01T00:00:00');
    const dest = addDestination(db, { placeId: p, orderIndex: 0, nights: 3 }, null, '2026-06-01T00:00:00');
    setStatus(db, 'destinations', dest, 'committed', 1, '2026-06-02T00:00:00');
    expect((db.query('SELECT status FROM destinations WHERE id = $id').get({ $id: dest }) as any).status).toBe('committed');
    const j = db.query("SELECT action FROM journal WHERE action = 'plan.destinations.status'").get() as any;
    expect(j.action).toBe('plan.destinations.status');
  });

  test('setStatus rejects an unknown table or status', () => {
    const db = seed();
    expect(() => setStatus(db, 'robots' as any, 1, 'committed', 1, '2026-06-02T00:00:00')).toThrow(/unknown table/);
    const p = addPlace(db, { name: 'Goa' }, null, '2026-06-01T00:00:00');
    const dest = addDestination(db, { placeId: p, orderIndex: 0, nights: 3 }, null, '2026-06-01T00:00:00');
    expect(() => setStatus(db, 'destinations', dest, 'maybe' as any, 1, '2026-06-02T00:00:00')).toThrow(/unknown status/);
  });
});
