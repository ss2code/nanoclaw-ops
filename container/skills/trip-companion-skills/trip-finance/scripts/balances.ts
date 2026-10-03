import type { Database } from 'bun:sqlite';
import { minorUnitDigits } from './money';

/**
 * Net position per member per currency, in minor units.
 * Positive = is owed money; negative = owes money.
 * Voided expenses are excluded; settlements (from → to) raise `from` and lower `to`.
 * Invariant: per currency, nets sum to exactly zero.
 */
export type Balances = Map<string, Map<number, number>>;

export function computeBalances(db: Database): Balances {
  const balances: Balances = new Map();
  const add = (currency: string, memberId: number, delta: number) => {
    let perMember = balances.get(currency);
    if (!perMember) {
      perMember = new Map();
      balances.set(currency, perMember);
    }
    perMember.set(memberId, (perMember.get(memberId) ?? 0) + delta);
  };

  const expenses = db
    .query('SELECT id, amount, currency, payer_member_id FROM expenses WHERE voided_at IS NULL')
    .all() as { id: number; amount: number; currency: string; payer_member_id: number }[];
  const shareStmt = db.query(
    'SELECT member_id, share_amount FROM expense_shares WHERE expense_id = $id',
  );
  for (const e of expenses) {
    add(e.currency, e.payer_member_id, e.amount);
    const shares = shareStmt.all({ $id: e.id }) as { member_id: number; share_amount: number }[];
    for (const s of shares) add(e.currency, s.member_id, -s.share_amount);
  }

  const settlements = db
    .query('SELECT from_member, to_member, amount, currency FROM settlements')
    .all() as { from_member: number; to_member: number; amount: number; currency: string }[];
  for (const s of settlements) {
    add(s.currency, s.from_member, s.amount);
    add(s.currency, s.to_member, -s.amount);
  }

  return balances;
}

export function assertZeroSum(balances: Balances): void {
  for (const [currency, perMember] of balances) {
    let sum = 0;
    for (const v of perMember.values()) sum += v;
    if (sum !== 0) throw new Error(`balances for ${currency} sum to ${sum}, expected 0`);
  }
}

/**
 * Fold all currencies into `base` at EXPLICITLY provided rates — never invented
 * ones (design §5). `rates[c]` = how many major units of base per 1 major unit
 * of c (e.g. { USD: 84 } for INR base). Journaling the rate is the caller's job.
 * Per-member rounding can leave a residual of a few minor units; it is assigned
 * to the member with the largest absolute balance so the zero-sum invariant holds.
 */
export function consolidate(
  balances: Balances,
  base: string,
  rates: Record<string, number>,
): Map<number, number> {
  const baseUpper = base.toUpperCase();
  const out = new Map<number, number>();
  const add = (memberId: number, delta: number) => out.set(memberId, (out.get(memberId) ?? 0) + delta);

  for (const [currency, perMember] of balances) {
    if (currency === baseUpper) {
      for (const [id, v] of perMember) add(id, v);
      continue;
    }
    const rate = rates[currency];
    if (!(Number.isFinite(rate) && rate > 0)) {
      throw new Error(`no explicit rate provided for ${currency} → ${baseUpper}`);
    }
    const factor = rate * 10 ** (minorUnitDigits(baseUpper) - minorUnitDigits(currency));
    for (const [id, v] of perMember) add(id, Math.round(v * factor));
  }

  let residual = 0;
  for (const v of out.values()) residual += v;
  if (residual !== 0) {
    let target: number | null = null;
    let best = -1;
    for (const [id, v] of out) {
      if (Math.abs(v) > best || (Math.abs(v) === best && (target === null || id < target))) {
        best = Math.abs(v);
        target = id;
      }
    }
    if (target !== null) out.set(target, out.get(target)! - residual);
  }
  return out;
}
