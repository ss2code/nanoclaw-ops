import { describe, expect, test } from 'bun:test';
import { openDb } from '../scripts/db';
import { addMember, setTrip, updateMember } from '../scripts/config';
import { getItems, getShares, logExpense } from '../scripts/ledger';
import { budgetBurn } from '../scripts/burn';

function seed() { const db = openDb(':memory:'); setTrip(db, { name: 'T', baseCurrency: 'INR', startDate: '2026-08-01', endDate: '2026-08-05' }, null, '2026-01-01T00:00:00Z'); const a = addMember(db, { displayName: 'A', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00Z'); const b = addMember(db, { displayName: 'B', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00Z'); return { db, a, b }; }
describe('itemised splits and burn', () => {
  test('aggregates item shares exactly and retains audit items', () => { const { db, a, b } = seed(); const id = logExpense(db, { description: 'Dinner', amountMinor: 450000, currency: 'INR', payerId: a, rule: 'equal-all', at: '2026-08-03T19:00:00Z', items: [{ label: 'Beer', amountMinor: 60000, memberIds: [a] }, { label: 'Food', amountMinor: 390000, memberIds: [a, b] }] }); expect([...getShares(db, id).values()].reduce((x, y) => x + y, 0)).toBe(450000); expect(getItems(db, id)).toHaveLength(2); });
  test('never silently converts foreign spend in a budget burn', () => { const { db, a, b } = seed(); db.query('UPDATE trip SET total_budget=500000 WHERE id=1').run(); logExpense(db, { description: 'Hotel', amountMinor: 100000, currency: 'INR', payerId: a, rule: 'equal-all', at: '2026-08-02T10:00:00Z' }); logExpense(db, { description: 'USD', amountMinor: 1000, currency: 'USD', payerId: b, rule: 'equal-all', at: '2026-08-02T10:00:00Z' }); const burn: any = budgetBurn(db, '2026-08-03T10:00:00Z'); expect(burn.baseSpent).toBe(100000); expect(burn.foreignSpend).toHaveLength(1); });
  test('UPI stores on the member and remains separate from finance math', () => { const { db, a } = seed(); updateMember(db, a, { upiId: 'a@bank' }, a, '2026-01-01T01:00:00Z'); expect((db.query('SELECT upi_id FROM members WHERE id=$id').get({ $id: a }) as any).upi_id).toBe('a@bank'); });
});
