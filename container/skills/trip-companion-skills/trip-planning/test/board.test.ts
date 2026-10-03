import { describe, expect, test } from 'bun:test';
import { openPlanningDb } from '../scripts/db';
import { addMember, setTrip } from '../../trip-core/scripts/config';
import { addPlace } from '../scripts/places';
import { addDay, addItem, addLeg, addStay, addDestination, setStatus } from '../scripts/items';
import { renderBoard } from '../scripts/board';

function seed() {
  const db = openPlanningDb(':memory:');
  setTrip(db, { name: 'Goa 2026', baseCurrency: 'INR', startDate: '2026-08-14', endDate: '2026-08-15' }, null, '2026-06-01T00:00:00');
  const arjun = addMember(db, { displayName: 'Arjun', joinedAt: '2026-06-01' }, null, '2026-06-01T00:00:00');
  const goa = addPlace(db, { name: 'Goa' }, null, '2026-06-01T00:00:00');
  const blr = addPlace(db, { name: 'BLR' }, null, '2026-06-01T00:00:00');
  const commit = (t: any, id: number) => setStatus(db, t, id, 'committed', 1, '2026-06-02T00:00:00');

  commit('destinations', addDestination(db, { placeId: goa, orderIndex: 0, nights: 1 }, null, '2026-06-01T00:00:00'));
  commit('stays', addStay(db, { placeId: goa, checkIn: '2026-08-14', checkOut: '2026-08-15', nights: 1, costPerNight: 200000 }, null, '2026-06-01T00:00:00'));
  // Flights: only inbound committed (outbound missing) → partial
  commit('legs', addLeg(db, { memberId: arjun, fromPlaceId: blr, toPlaceId: goa, mode: 'flight', direction: 'inbound', cost: 600000 }, null, '2026-06-01T00:00:00'));

  const day1 = addDay(db, { date: '2026-08-14', basePlaceId: goa }, null, '2026-06-01T00:00:00');
  addItem(db, { dayId: day1, slot: 'midday', type: 'activity', title: 'Fort', cost: 60000 }, null, '2026-06-01T00:00:00'); // candidate
  const day2 = addDay(db, { date: '2026-08-15', basePlaceId: goa }, null, '2026-06-01T00:00:00');
  commit('itinerary_items', addItem(db, { dayId: day2, slot: 'midday', type: 'activity', title: 'Beach', cost: 0 }, null, '2026-06-01T00:00:00'));
  return { db, day1, day2 };
}

describe('live plan board (§8)', () => {
  test('renders one section per concern with status badges', () => {
    const { db } = seed();
    const board = renderBoard(db);
    const badge = (label: string) => board.sections.find((s) => s.label.startsWith(label))?.badge;
    expect(badge('Where')).toBe('✅');
    expect(badge('Stay')).toBe('✅');
    expect(badge('Flights')).toBe('🟡'); // 1 of 2 legs committed
    expect(badge('Day 1')).toBe('⬜'); // item still a candidate
    expect(badge('Day 2')).toBe('✅');
    expect(badge('Meals')).toBe('⬜'); // none added
  });

  test('completeness % is committed sections over total, rounded', () => {
    const { db } = seed();
    // ✅: Where, Stay, Day 2 = 3 of 6 sections → 50%
    expect(renderBoard(db).completeness).toBe(50);
  });

  test('text render carries the % and the badges', () => {
    const { db } = seed();
    const t = renderBoard(db).text;
    expect(t).toContain('50% set');
    expect(t).toContain('✅');
    expect(t).toContain('🟡');
    expect(t).toContain('⬜');
  });

  test('feasibility errors overlay a ⚠️ on the affected section', () => {
    const { db, day2 } = seed();
    const board = renderBoard(db, { errors: [{ section: `Day 2`, day: day2, message: 'museum closes before you arrive' }] });
    const d2 = board.sections.find((s) => s.label.startsWith('Day 2'));
    expect(d2?.badge).toBe('⚠️');
    expect(d2?.detail).toContain('museum closes before you arrive');
    expect(board.text).toContain('⚠️');
  });
});
