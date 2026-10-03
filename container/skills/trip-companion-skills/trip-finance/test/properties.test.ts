import { describe, expect, test } from 'bun:test';
import { openDb } from '../scripts/db';
import { addFamily, addMember } from '../scripts/config';
import { editExpense, getShares, logExpense, logSettlement, voidExpense } from '../scripts/ledger';
import { computeBalances, consolidate } from '../scripts/balances';
import { settlementPlan } from '../scripts/settle';
import { computeShares, type CustomSpec } from '../scripts/split';

// Deterministic PRNG (mulberry32) — seeded so failures are reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, arr: T[]): T => arr[randInt(r, 0, arr.length - 1)];

const CURRENCIES = ['INR', 'USD', 'JPY'];

interface Scenario {
  db: ReturnType<typeof openDb>;
  memberIds: number[];
  expenseIds: number[];
}

function buildScenario(seed: number): Scenario {
  const r = rng(seed);
  const db = openDb(':memory:');
  const at = '2026-12-20T00:00:00';

  const memberIds: number[] = [];
  const nFamilies = randInt(r, 1, 4);
  for (let f = 0; f < nFamilies; f++) {
    const fid = addFamily(db, `Family${f}`, null, at);
    const size = randInt(r, 1, 4);
    for (let m = 0; m < size; m++) {
      memberIds.push(
        addMember(db, { displayName: `F${f}M${m}`, familyId: fid, joinedAt: '2026-12-20' }, null, at),
      );
    }
  }
  for (let s = 0, n = randInt(r, 1, 3); s < n; s++) {
    memberIds.push(addMember(db, { displayName: `Solo${s}`, joinedAt: '2026-12-20' }, null, at));
  }
  // One split-excluded member (the "driver") who must never pick up automatic shares.
  addMember(db, { displayName: 'Driver', joinedAt: '2026-12-20', excludedFromSplits: true }, null, at);

  const expenseIds: number[] = [];
  const nEvents = randInt(r, 15, 40);
  for (let i = 0; i < nEvents; i++) {
    const when = `2026-12-${String(20 + (i % 7)).padStart(2, '0')}T12:${String(i % 60).padStart(2, '0')}:00`;
    const kind = r();
    if (kind < 0.7 || expenseIds.length === 0) {
      // log an expense — amounts biased toward crumb-heavy odd numbers
      const amount = randInt(r, 1, 1_000_000) * (r() < 0.5 ? 1 : 7) + randInt(r, 0, 9);
      const payer = pick(r, memberIds);
      const ruleRoll = r();
      let rule: 'equal-all' | 'by-family' | 'custom' = 'equal-all';
      let custom: CustomSpec | undefined;
      if (ruleRoll < 0.3) {
        rule = 'by-family';
      } else if (ruleRoll < 0.5) {
        rule = 'custom';
        const excluded = memberIds.filter(() => r() < 0.3);
        if (excluded.length >= memberIds.length) excluded.pop();
        custom = { kind: 'exclude', memberIds: excluded };
      } else if (ruleRoll < 0.65) {
        rule = 'custom';
        const weights: Record<string, number> = {};
        for (const id of memberIds) if (r() < 0.6) weights[id] = randInt(r, 1, 9);
        if (Object.keys(weights).length === 0) weights[pick(r, memberIds)] = 1;
        custom = { kind: 'ratio-by-member', weights };
      } else if (ruleRoll < 0.8) {
        rule = 'custom';
        // random exact partition of `amount` over a random subset
        const subset = memberIds.filter(() => r() < 0.5);
        if (subset.length === 0) subset.push(pick(r, memberIds));
        const shares: Record<string, number> = {};
        let rem = amount;
        for (let j = 0; j < subset.length; j++) {
          const left = subset.length - j - 1;
          const v = j === subset.length - 1 ? rem : randInt(r, 1, Math.max(1, rem - left));
          shares[subset[j]] = v;
          rem -= v;
        }
        if (rem !== 0) shares[subset[subset.length - 1]] += rem; // defensive; partition is exact by construction
        custom = { kind: 'explicit', shares };
      }
      expenseIds.push(
        logExpense(db, {
          description: `expense ${i}`,
          amountMinor: amount,
          currency: pick(r, CURRENCIES),
          payerId: payer,
          rule,
          custom,
          loggedBy: pick(r, memberIds),
          at: when,
        }),
      );
    } else if (kind < 0.82) {
      const from = pick(r, memberIds);
      let to = pick(r, memberIds);
      if (to === from) to = memberIds[(memberIds.indexOf(from) + 1) % memberIds.length];
      logSettlement(db, {
        fromId: from,
        toId: to,
        amountMinor: randInt(r, 1, 500_000),
        currency: pick(r, CURRENCIES),
        loggedBy: from,
        at: when,
      });
    } else if (kind < 0.92) {
      // edit a random non-voided expense's amount
      const id = pick(r, expenseIds);
      try {
        editExpense(db, id, { amountMinor: randInt(r, 1, 2_000_000) }, pick(r, memberIds), when);
      } catch (e) {
        // Two legitimate refusals: editing a voided expense, and changing only the
        // amount of an explicit-split expense (its frozen shares would no longer sum).
        if (!/voided|explicit shares sum/.test(String(e))) throw e;
      }
    } else {
      const id = pick(r, expenseIds);
      try {
        voidExpense(db, id, pick(r, memberIds), when);
      } catch (e) {
        if (!/already voided/.test(String(e))) throw e;
      }
    }
  }
  return { db, memberIds, expenseIds };
}

describe('property checks over random scenarios', () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7);

  test('shares always sum to the expense amount (active and voided)', () => {
    for (const seed of SEEDS) {
      const { db } = buildScenario(seed);
      const rows = db.query('SELECT id, amount FROM expenses').all() as { id: number; amount: number }[];
      for (const row of rows) {
        let sum = 0;
        for (const v of getShares(db, row.id).values()) sum += v;
        expect(sum, `seed ${seed} expense ${row.id}`).toBe(row.amount);
      }
    }
  });

  test('net balances sum to zero per currency', () => {
    for (const seed of SEEDS) {
      const { db } = buildScenario(seed);
      for (const [currency, perMember] of computeBalances(db)) {
        let sum = 0;
        for (const v of perMember.values()) sum += v;
        expect(sum, `seed ${seed} ${currency}`).toBe(0);
      }
    }
  });

  test('the split-excluded member never receives an automatic share', () => {
    for (const seed of SEEDS) {
      const { db } = buildScenario(seed);
      const driver = db
        .query("SELECT id FROM members WHERE display_name = 'Driver'")
        .get() as { id: number };
      const n = (
        db
          .query('SELECT COUNT(*) AS n FROM expense_shares WHERE member_id = $id')
          .get({ $id: driver.id }) as { n: number }
      ).n;
      expect(n, `seed ${seed}`).toBe(0);
    }
  });

  test('settlement plan conserves money, zeroes balances, uses ≤ n-1 transfers', () => {
    for (const seed of SEEDS) {
      const { db } = buildScenario(seed);
      for (const [currency, perMember] of computeBalances(db)) {
        const plan = settlementPlan(perMember);
        const nonzero = [...perMember.values()].filter((v) => v !== 0).length;
        expect(plan.length, `seed ${seed} ${currency}`).toBeLessThanOrEqual(Math.max(0, nonzero - 1));
        const after = new Map(perMember);
        for (const t of plan) {
          expect(t.amount).toBeGreaterThan(0);
          expect(t.from).not.toBe(t.to);
          after.set(t.from, (after.get(t.from) ?? 0) + t.amount);
          after.set(t.to, (after.get(t.to) ?? 0) - t.amount);
        }
        for (const v of after.values()) expect(v, `seed ${seed} ${currency}`).toBe(0);
      }
    }
  });

  test('explicit-rate consolidation is zero-sum', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const { db } = buildScenario(seed);
      const folded = consolidate(computeBalances(db), 'INR', { USD: 83.61, JPY: 0.57 });
      let sum = 0;
      for (const v of folded.values()) sum += v;
      expect(sum, `seed ${seed}`).toBe(0);
    }
  });
});

describe('crumb policy (pure computeShares)', () => {
  const participants = [
    { id: 1, familyId: 1 },
    { id: 2, familyId: 1 },
    { id: 3, familyId: null },
    { id: 4, familyId: null },
    { id: 5, familyId: 2 },
    { id: 6, familyId: 2 },
    { id: 7, familyId: 2 },
  ];

  test('equal-all: payer absorbs the whole crumb; everyone else gets the floor', () => {
    const r = rng(42);
    for (let i = 0; i < 500; i++) {
      const amount = randInt(r, 1, 10_000_000);
      const payerId = pick(r, participants).id;
      const shares = computeShares({ amountMinor: amount, rule: 'equal-all', payerId, participants });
      const base = Math.floor(amount / participants.length);
      let sum = 0;
      for (const [id, v] of shares) {
        sum += v;
        if (id !== payerId) expect(v).toBe(base);
      }
      expect(sum).toBe(amount);
      expect(shares.get(payerId)!).toBe(base + (amount - base * participants.length));
    }
  });

  test('equal-all: payer outside the pool → first crumb-many ids get +1', () => {
    // 100 split 7 ways by an outside payer (id 99): base 14, crumb 2 → ids 1,2 get 15
    const shares = computeShares({ amountMinor: 100, rule: 'equal-all', payerId: 99, participants });
    expect([...shares.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 15], [2, 15], [3, 14], [4, 14], [5, 14], [6, 14], [7, 14],
    ]);
  });

  test('explicit shares must sum exactly — off-by-one is rejected', () => {
    expect(() =>
      computeShares({
        amountMinor: 100,
        rule: 'custom',
        custom: { kind: 'explicit', shares: { 1: 50, 2: 49 } },
        payerId: 1,
        participants,
      }),
    ).toThrow(/sum to 99/);
  });

  test('excluding every participant is rejected', () => {
    expect(() =>
      computeShares({
        amountMinor: 100,
        rule: 'custom',
        custom: { kind: 'exclude', memberIds: participants.map((p) => p.id) },
        payerId: 1,
        participants,
      }),
    ).toThrow(/no participants/);
  });
});
