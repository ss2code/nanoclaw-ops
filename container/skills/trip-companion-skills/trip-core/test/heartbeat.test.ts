import { describe, expect, test } from 'bun:test';
import { openCoreDb } from '../scripts/db';
import { setTrip, addMember } from '../scripts/config';
import { openDecision, recordObjection } from '../scripts/decisions';
import { heartbeat } from '../scripts/heartbeat';

describe('heartbeat', () => {
  test('is safe for an unconfigured database', () => {
    const result = heartbeat(openCoreDb(':memory:'), '2026-08-01T08:00:00Z');
    expect(result).toMatchObject({ wakeAgent: false, data: { reason: 'trip not configured' } });
  });
  test('reports only due, unobjected propose decisions deterministically', () => {
    const db = openCoreDb(':memory:'); setTrip(db, { name: 'T' }, null, '2026-01-01T00:00:00Z');
    const member = addMember(db, { displayName: 'A', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00Z');
    const due = openDecision(db, { question: 'Book?', mode: 'propose', commitBy: '2026-01-02T00:00:00Z', openedBy: member }, '2026-01-01T00:00:00Z');
    const blocked = openDecision(db, { question: 'No', mode: 'propose', commitBy: '2026-01-02T00:00:00Z', openedBy: member }, '2026-01-01T00:00:00Z');
    recordObjection(db, blocked, member, 'wait', '2026-01-01T01:00:00Z');
    const first = heartbeat(db, '2026-01-03T00:00:00Z'); const second = heartbeat(db, '2026-01-03T00:00:00Z');
    expect(first.data.sections.decisionsDue).toEqual([{ id: due, question: 'Book?', commitBy: '2026-01-02T00:00:00Z' }]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
