import { describe, expect, test } from 'bun:test';
import { openPlanningDb } from '../scripts/db';
import { addMember, setTrip } from '../../trip-core/scripts/config';
import { dueForAutoCommit, openDecision, recordObjection } from '../../trip-core/scripts/decisions';
import { addPlace } from '../scripts/places';
import { addDestination } from '../scripts/items';
import { commitDecision } from '../scripts/consensus';

function seed() {
  const db = openPlanningDb(':memory:');
  setTrip(db, { name: 'Goa', baseCurrency: 'INR' }, null, '2026-06-01T00:00:00');
  addMember(db, { displayName: 'Arjun', joinedAt: '2026-06-01' }, null, '2026-06-01T00:00:00');
  const goa = addPlace(db, { name: 'Goa' }, null, '2026-06-01T00:00:00');
  const dest = addDestination(db, { placeId: goa, orderIndex: 0, nights: 3 }, null, '2026-06-01T00:00:00');
  return { db, dest };
}

describe('consensus write-through (§14)', () => {
  test('an un-objected propose-decision is due after its deadline; commitDecision flips the item + closes it', () => {
    const { db, dest } = seed();
    const d = openDecision(db, { question: 'Lock Goa?', mode: 'propose', commitBy: '2026-06-20T21:00:00', stage: 'planning', openedBy: 1 }, '2026-06-18T00:00:00');

    const due = dueForAutoCommit(db, '2026-06-20T21:30:00');
    expect(due.map((x) => x.id)).toEqual([d]);

    commitDecision(db, { decisionId: d, outcome: 'Goa', items: [{ table: 'destinations', id: dest }] }, 1, '2026-06-20T21:30:00');

    expect((db.query('SELECT status FROM destinations WHERE id = $id').get({ $id: dest }) as any).status).toBe('committed');
    const dec = db.query('SELECT status, outcome FROM decisions WHERE id = $id').get({ $id: d }) as any;
    expect(dec.status).toBe('closed');
    expect(dec.outcome).toBe('Goa');
  });

  test('an objected decision is NOT auto-committed', () => {
    const { db, dest } = seed();
    const d = openDecision(db, { question: 'Lock cruise?', mode: 'propose', commitBy: '2026-06-20T21:00:00', openedBy: 1 }, '2026-06-18T00:00:00');
    recordObjection(db, d, 1, '2026-06-19T00:00:00');
    expect(dueForAutoCommit(db, '2026-06-21T00:00:00').map((x) => x.id)).toEqual([]);
  });

  test('commitDecision is journaled as a consensus commit', () => {
    const { db, dest } = seed();
    const d = openDecision(db, { question: 'Lock Goa?', mode: 'propose', openedBy: 1 }, '2026-06-18T00:00:00');
    commitDecision(db, { decisionId: d, outcome: 'Goa', items: [{ table: 'destinations', id: dest }] }, 1, '2026-06-20T00:00:00');
    const j = db.query("SELECT COUNT(*) AS n FROM journal WHERE action = 'consensus.commit'").get() as { n: number };
    expect(j.n).toBe(1);
  });
});
