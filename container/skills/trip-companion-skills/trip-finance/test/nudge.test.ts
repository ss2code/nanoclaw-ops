import { expect, test } from 'bun:test';
import { openDb } from '../scripts/db';
import { setTrip, addMember } from '../scripts/config';
import { logExpense } from '../scripts/ledger';
import { nudgeStatus, recordNudge } from '../scripts/nudge';
test('settlement nudge normalizes transfer-edge order and detects a changed ledger', () => {
  const db = openDb(':memory:'); setTrip(db, { name: 'G' }, null, '2026-01-01T00:00:00Z'); const a = addMember(db, { displayName: 'A', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00Z'); const b = addMember(db, { displayName: 'B', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00Z');
  logExpense(db, { description: 'Hotel', amountMinor: 1000, currency: 'INR', payerId: a, rule: 'equal-all', custom: null, source: 'text', loggedBy: a, at: '2026-01-01T00:00:00Z' }); recordNudge(db, '2026-01-02T00:00:00Z', a); expect(nudgeStatus(db)).toMatchObject({ count: 1, edgesChangedSinceLastNudge: false });
  logExpense(db, { description: 'Taxi', amountMinor: 300, currency: 'INR', payerId: b, rule: 'equal-all', custom: null, source: 'text', loggedBy: b, at: '2026-01-03T00:00:00Z' }); expect(nudgeStatus(db).edgesChangedSinceLastNudge).toBe(true);
});
