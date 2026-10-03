import { describe, expect, test } from 'bun:test';
import { openPlanningDb } from '../scripts/db';
import { setTrip, addMember } from '../../trip-core/scripts/config';
import { addPlace, safetyCard, setPlaceInfo, stayCard, unsetPlaceInfo } from '../scripts/places';
import { addDestination, addStay, setStatus } from '../scripts/items';

test('stay and safety cards select committed current state and expose exact gaps', () => {
  const db = openPlanningDb(':memory:'); setTrip(db, { name: 'Goa', startDate: '2026-08-14' }, null, '2026-01-01T00:00:00Z'); const a = addMember(db, { displayName: 'A', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00Z');
  const p = addPlace(db, { name: 'Villa', address: 'Beach Road', mapUrl: 'map' }, a, '2026-01-01T00:00:00Z'); const d = addDestination(db, { placeId: p, orderIndex: 0, nights: 2 }, a, '2026-01-01T00:00:00Z'); const s = addStay(db, { destinationId: d, placeId: p, checkIn: '2026-08-14', checkOut: '2026-08-16', nights: 2 }, a, '2026-01-01T00:00:00Z'); setStatus(db, 'destinations', d, 'committed', a, '2026-01-01T00:00:00Z'); setStatus(db, 'stays', s, 'committed', a, '2026-01-01T00:00:00Z');
  setPlaceInfo(db, p, 'wifi', 'Villa / pass', 'source', a, '2026-08-14T00:00:00Z'); setPlaceInfo(db, p, 'pharmacy', 'Main Road', 'source', a, '2026-08-14T00:00:00Z');
  expect(stayCard(db, '2026-08-15').missing).not.toContain('wifi'); expect(() => stayCard(db, '2026-08-16')).toThrow(/no committed stay/);
  expect(safetyCard(db, '2026-08-15').info[0].key).toBe('pharmacy'); unsetPlaceInfo(db, p, 'wifi', a, '2026-08-15T00:00:00Z'); expect(stayCard(db, '2026-08-15').missing).toContain('wifi');
});
