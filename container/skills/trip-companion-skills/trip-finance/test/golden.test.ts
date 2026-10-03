import { describe, expect, test } from 'bun:test';
import { openDb } from '../scripts/db';
import { addFamily, addMember, setTrip } from '../scripts/config';
import { editExpense, getExpense, getShares, logExpense, logSettlement, voidExpense } from '../scripts/ledger';
import { assertZeroSum, computeBalances, consolidate, type Balances } from '../scripts/balances';
import { settlementPlan } from '../scripts/settle';
import {
  EVENTS,
  EXPECTED_JOURNAL_ROWS,
  FAMILIES,
  GOLDEN_DAY2_INR,
  GOLDEN_DAY5_INR,
  GOLDEN_DAY5_USD,
  GOLDEN_END_INR,
  GOLDEN_END_USD,
  MEMBERS,
  TRIP,
} from './fixtures/goa-2026';

function balanceOf(balances: Balances, currency: string, memberId: number): number {
  return balances.get(currency)?.get(memberId) ?? 0;
}

function expectGolden(balances: Balances, currency: string, golden: Record<number, number>, label: string) {
  for (const [idStr, expected] of Object.entries(golden)) {
    const actual = balanceOf(balances, currency, Number(idStr));
    expect(actual, `${label} ${currency} member ${idStr}`).toBe(expected);
  }
  // No one outside the golden table carries a balance (e.g. the driver, member 12).
  for (const [id, v] of balances.get(currency) ?? []) {
    if (!(id in golden)) expect(v, `${label} ${currency} unexpected member ${id}`).toBe(0);
  }
}

describe('Goa 2026 golden replay', () => {
  const db = openDb(':memory:');

  // Seed config (journaled, actor = owner Arjun once he exists; trip/families seeded by null actor)
  setTrip(db, TRIP, null, '2026-12-19T09:00:00');
  const familyIds: Record<string, number> = {};
  for (const f of FAMILIES) familyIds[f.key] = addFamily(db, f.name, null, '2026-12-19T09:05:00');
  for (const m of MEMBERS) {
    const id = addMember(
      db,
      {
        displayName: m.name,
        familyId: m.family ? familyIds[m.family] : null,
        joinedAt: m.joined,
        excludedFromSplits: 'excluded' in m && Boolean(m.excluded),
      },
      null,
      '2026-12-19T09:10:00',
    );
    expect(id).toBe(m.id); // fixture relies on insertion-order ids
  }

  const expenseIdByLabel: Record<string, number> = {};

  test('full replay matches hand-computed goldens at all three checkpoints', () => {
    for (const ev of EVENTS) {
      if (ev.type === 'expense') {
        expenseIdByLabel[ev.label] = logExpense(db, {
          description: ev.desc,
          amountMinor: ev.amount,
          currency: ev.currency,
          payerId: ev.payer,
          rule: ev.rule,
          custom: ev.custom ?? null,
          loggedBy: ev.loggedBy ?? ev.payer,
          at: ev.at,
        });
      } else if (ev.type === 'settlement') {
        logSettlement(db, {
          fromId: ev.from,
          toId: ev.to,
          amountMinor: ev.amount,
          currency: ev.currency,
          loggedBy: ev.from,
          at: ev.at,
        });
      } else if (ev.type === 'edit') {
        editExpense(db, expenseIdByLabel[ev.target], ev.patch, ev.actor, ev.at);
      } else {
        voidExpense(db, expenseIdByLabel[ev.target], ev.actor, ev.at);
      }

      // Zero-sum invariant holds after EVERY event, not just at checkpoints.
      const balances = computeBalances(db);
      assertZeroSum(balances);

      if (ev.label === 'E9') {
        expectGolden(balances, 'INR', GOLDEN_DAY2_INR, 'day2');
        expect(balances.has('USD')).toBe(false);
      }
      if (ev.label === 'E26') {
        expectGolden(balances, 'INR', GOLDEN_DAY5_INR, 'day5');
        expectGolden(balances, 'USD', GOLDEN_DAY5_USD, 'day5');
      }
      if (ev.label === 'E40') {
        expectGolden(balances, 'INR', GOLDEN_END_INR, 'end');
        expectGolden(balances, 'USD', GOLDEN_END_USD, 'end');
      }
    }
  });

  test('every expense (active or voided) has shares summing exactly to its amount', () => {
    const rows = db.query('SELECT id, amount FROM expenses').all() as { id: number; amount: number }[];
    expect(rows.length).toBe(36);
    for (const r of rows) {
      let sum = 0;
      for (const v of getShares(db, r.id).values()) sum += v;
      expect(sum, `expense ${r.id}`).toBe(r.amount);
    }
  });

  test('voided duplicate is excluded from balances but preserved in history', () => {
    const voided = getExpense(db, expenseIdByLabel['E26'])!;
    expect(voided.voided_at).not.toBeNull();
    expect(getShares(db, voided.id).size).toBe(11); // shares retained for the journal/history
  });

  test('edited expense reflects the corrected amount and journals before/after', () => {
    const edited = getExpense(db, expenseIdByLabel['E25'])!;
    expect(edited.amount).toBe(400_000);
    const row = db
      .query("SELECT before_json, after_json FROM journal WHERE action = 'expense.edit'")
      .get() as { before_json: string; after_json: string };
    expect(JSON.parse(row.before_json).expense.amount).toBe(360_000);
    expect(JSON.parse(row.after_json).expense.amount).toBe(400_000);
  });

  test('journal recorded every mutation', () => {
    const n = (db.query('SELECT COUNT(*) AS n FROM journal').get() as { n: number }).n;
    expect(n).toBe(EXPECTED_JOURNAL_ROWS);
  });

  test('settlement plan zeroes every currency in at most n-1 transfers', () => {
    const balances = computeBalances(db);
    for (const [currency, perMember] of balances) {
      const plan = settlementPlan(perMember);
      const nonzero = [...perMember.values()].filter((v) => v !== 0).length;
      expect(plan.length).toBeLessThanOrEqual(Math.max(0, nonzero - 1));
      const after = new Map(perMember);
      for (const t of plan) {
        expect(t.amount).toBeGreaterThan(0);
        after.set(t.from, (after.get(t.from) ?? 0) + t.amount);
        after.set(t.to, (after.get(t.to) ?? 0) - t.amount);
      }
      for (const [id, v] of after) expect(v, `${currency} member ${id} after settling`).toBe(0);
    }
  });

  test('explicit-rate consolidation folds USD into INR and stays zero-sum', () => {
    const balances = computeBalances(db);
    const folded = consolidate(balances, 'INR', { USD: 84 });
    let sum = 0;
    for (const v of folded.values()) sum += v;
    expect(sum).toBe(0);
    // Arjun: 4,654,970 paise + 3,157 cents × 84 (INR/USD major) = 4,654,970 + 265,188 paise
    expect(folded.get(1)).toBe(4_654_970 + Math.round(3_157 * 84));
  });

  test('consolidation without a rate for a held currency is refused', () => {
    expect(() => consolidate(computeBalances(db), 'INR', {})).toThrow(/no explicit rate/);
  });
});
