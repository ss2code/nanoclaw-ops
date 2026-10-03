import type { Database } from 'bun:sqlite';
import { activeMembers, activeParticipants, appendJournal, getMember } from './db';
import { assertMinor } from './money';
import { computeShares, type CustomSpec, type SplitRule } from './split';

export interface ExpenseRow {
  id: number;
  description: string;
  amount: number;
  currency: string;
  payer_member_id: number;
  split_rule: string;
  custom_spec: string | null;
  source: string;
  logged_by: number | null;
  logged_at: string;
  voided_at: string | null;
}

export interface LogExpenseInput {
  description: string;
  amountMinor: number;
  currency: string;
  payerId: number;
  rule: SplitRule;
  custom?: CustomSpec | null;
  source?: 'text' | 'upi-image' | 'bill-image';
  loggedBy?: number | null;
  at: string; // ISO datetime the expense is logged for
  items?: ItemisedInput[];
}
export interface ItemisedInput { label: string; amountMinor: number; memberIds: number[]; }

export function getExpense(db: Database, id: number): ExpenseRow | null {
  return db.query('SELECT * FROM expenses WHERE id = $id').get({ $id: id }) as ExpenseRow | null;
}

export function getShares(db: Database, expenseId: number): Map<number, number> {
  const rows = db
    .query('SELECT member_id, share_amount FROM expense_shares WHERE expense_id = $id ORDER BY member_id')
    .all({ $id: expenseId }) as { member_id: number; share_amount: number }[];
  return new Map(rows.map((r) => [r.member_id, r.share_amount]));
}

function resolveShares(db: Database, input: LogExpenseInput, asOf: string): Map<number, number> {
  if (input.items) {
    if (!input.items.length) throw new Error('items must be a non-empty array');
    const active = new Set(activeMembers(db, asOf).map((m) => m.id));
    const aggregate = new Map<number, number>();
    let total = 0;
    for (const item of input.items) {
      if (!item.label || !item.memberIds.length) throw new Error('each item needs a label and at least one member');
      if (!Number.isSafeInteger(item.amountMinor) || item.amountMinor <= 0) throw new Error(`item "${item.label}" amount must be positive`);
      for (const id of item.memberIds) if (!active.has(id)) throw new Error(`member ${id} is not active on this date`);
      const shares = computeShares({ amountMinor: item.amountMinor, rule: 'equal-all', payerId: input.payerId, participants: item.memberIds.map((id) => ({ id, familyId: null })) });
      for (const [id, amount] of shares) aggregate.set(id, (aggregate.get(id) ?? 0) + amount);
      total += item.amountMinor;
    }
    if (total !== input.amountMinor) throw new Error(`item amounts sum to ${total}, expense amount is ${input.amountMinor}`);
    return aggregate;
  }
  const participants = activeParticipants(db, asOf).map((m) => ({ id: m.id, familyId: m.family_id }));
  const explicitEligible = new Set(activeMembers(db, asOf).map((m) => m.id));
  const shares = computeShares({
    amountMinor: input.amountMinor,
    rule: input.rule,
    custom: input.custom ?? null,
    payerId: input.payerId,
    participants,
    explicitEligible,
  });
  // The load-bearing invariant (design §3): sum(shares) === amount, always.
  let sum = 0;
  for (const v of shares.values()) sum += v;
  if (sum !== input.amountMinor) {
    throw new Error(`internal invariant violated: shares sum ${sum} !== amount ${input.amountMinor}`);
  }
  return shares;
}

function insertShares(db: Database, expenseId: number, shares: Map<number, number>): void {
  const stmt = db.query(
    'INSERT INTO expense_shares (expense_id, member_id, share_amount) VALUES ($eid, $mid, $share)',
  );
  for (const [memberId, share] of shares) stmt.run({ $eid: expenseId, $mid: memberId, $share: share });
}
function insertItems(db: Database, expenseId: number, items: ItemisedInput[]): void {
  const stmt = db.query('INSERT INTO expense_items (expense_id,label,amount,participants_json) VALUES ($expense,$label,$amount,$members)');
  for (const item of items) stmt.run({ $expense: expenseId, $label: item.label, $amount: item.amountMinor, $members: JSON.stringify(item.memberIds) });
}
export function getItems(db: Database, expenseId: number): { label: string; amount: number; memberIds: number[] }[] {
  return (db.query('SELECT label,amount,participants_json FROM expense_items WHERE expense_id=$id ORDER BY id').all({ $id: expenseId }) as any[]).map((x) => ({ label: x.label, amount: x.amount, memberIds: JSON.parse(x.participants_json) }));
}

export function logExpense(db: Database, input: LogExpenseInput): number {
  assertMinor(input.amountMinor, 'expense amount');
  if (input.amountMinor <= 0) throw new Error('expense amount must be positive');
  const payer = getMember(db, input.payerId);
  if (!payer) throw new Error(`payer member ${input.payerId} not found`);
  const currency = input.currency.toUpperCase();
  const shares = resolveShares(db, input, input.at);

  return db.transaction(() => {
    const res = db
      .query(
        `INSERT INTO expenses
           (description, amount, currency, payer_member_id, split_rule, custom_spec, source, logged_by, logged_at)
         VALUES ($desc, $amount, $cur, $payer, $rule, $custom, $source, $by, $at)`,
      )
      .run({
        $desc: input.description,
        $amount: input.amountMinor,
        $cur: currency,
        $payer: input.payerId,
        $rule: input.items ? 'itemised' : input.rule,
        $custom: input.items ? JSON.stringify(input.items) : input.custom ? JSON.stringify(input.custom) : null,
        $source: input.source ?? 'text',
        $by: input.loggedBy ?? null,
        $at: input.at,
      });
    const id = Number(res.lastInsertRowid);
    insertShares(db, id, shares);
    if (input.items) insertItems(db, id, input.items);
    appendJournal(db, {
      at: input.at,
      actorId: input.loggedBy ?? null,
      action: 'expense.log',
      entity: `expense:${id}`,
      before: null,
      after: { expense: getExpense(db, id), shares: Object.fromEntries(shares) },
    });
    return id;
  })();
}

export interface EditExpensePatch {
  description?: string;
  amountMinor?: number;
  currency?: string;
  payerId?: number;
  rule?: SplitRule;
  custom?: CustomSpec | null;
  items?: ItemisedInput[];
}

/**
 * Edits recompute shares against the roster as of the expense's ORIGINAL
 * logged_at — "past expenses freeze their own shares" (design §3): a member
 * who joined later never gains a share in an older expense via an edit.
 */
export function editExpense(
  db: Database,
  id: number,
  patch: EditExpensePatch,
  actorId: number | null,
  at: string,
): void {
  const before = getExpense(db, id);
  if (!before) throw new Error(`expense ${id} not found`);
  if (before.voided_at) throw new Error(`expense ${id} is voided; un-voiding is not supported — log it again`);
  const beforeShares = getShares(db, id);
  if (before.split_rule === 'itemised' && patch.amountMinor !== undefined && patch.items === undefined) throw new Error('itemised expense amount can only change when --items is re-supplied');
  const preservedItems: ItemisedInput[] | undefined = before.split_rule === 'itemised' && patch.items === undefined
    ? JSON.parse(before.custom_spec ?? '[]') as ItemisedInput[]
    : undefined;

  const merged: LogExpenseInput = {
    description: patch.description ?? before.description,
    amountMinor: patch.amountMinor ?? before.amount,
    currency: (patch.currency ?? before.currency).toUpperCase(),
    payerId: patch.payerId ?? before.payer_member_id,
    rule: patch.items || preservedItems ? 'equal-all' : patch.rule ?? (before.split_rule as SplitRule),
    custom:
      patch.custom !== undefined
        ? patch.custom
        : before.custom_spec
          ? (JSON.parse(before.custom_spec) as CustomSpec)
          : null,
    at: before.logged_at,
    items: patch.items ?? preservedItems,
  };
  const shares = resolveShares(db, merged, before.logged_at);

  db.transaction(() => {
    db.query(
      `UPDATE expenses SET description = $desc, amount = $amount, currency = $cur,
         payer_member_id = $payer, split_rule = $rule, custom_spec = $custom
       WHERE id = $id`,
    ).run({
      $id: id,
      $desc: merged.description,
      $amount: merged.amountMinor,
      $cur: merged.currency,
      $payer: merged.payerId,
      $rule: merged.items ? 'itemised' : merged.rule,
      $custom: merged.items ? JSON.stringify(merged.items) : merged.custom ? JSON.stringify(merged.custom) : null,
    });
    db.query('DELETE FROM expense_shares WHERE expense_id = $id').run({ $id: id });
    db.query('DELETE FROM expense_items WHERE expense_id = $id').run({ $id: id });
    insertShares(db, id, shares);
    if (merged.items) insertItems(db, id, merged.items);
    appendJournal(db, {
      at,
      actorId,
      action: 'expense.edit',
      entity: `expense:${id}`,
      before: { expense: before, shares: Object.fromEntries(beforeShares) },
      after: { expense: getExpense(db, id), shares: Object.fromEntries(shares) },
    });
  })();
}

/** Deletes are soft — the row and its shares stay; balances just stop counting them. */
export function voidExpense(db: Database, id: number, actorId: number | null, at: string): void {
  const before = getExpense(db, id);
  if (!before) throw new Error(`expense ${id} not found`);
  if (before.voided_at) throw new Error(`expense ${id} is already voided`);
  db.transaction(() => {
    db.query('UPDATE expenses SET voided_at = $at WHERE id = $id').run({ $at: at, $id: id });
    appendJournal(db, {
      at, actorId, action: 'expense.void', entity: `expense:${id}`, before, after: getExpense(db, id),
    });
  })();
}

export function logSettlement(
  db: Database,
  s: {
    fromId: number;
    toId: number;
    amountMinor: number;
    currency: string;
    loggedBy?: number | null;
    at: string;
  },
): number {
  assertMinor(s.amountMinor, 'settlement amount');
  if (s.amountMinor <= 0) throw new Error('settlement amount must be positive');
  if (s.fromId === s.toId) throw new Error('settlement needs two different members');
  if (!getMember(db, s.fromId)) throw new Error(`member ${s.fromId} not found`);
  if (!getMember(db, s.toId)) throw new Error(`member ${s.toId} not found`);

  return db.transaction(() => {
    const res = db
      .query(
        `INSERT INTO settlements (from_member, to_member, amount, currency, logged_by, logged_at)
         VALUES ($from, $to, $amount, $cur, $by, $at)`,
      )
      .run({
        $from: s.fromId,
        $to: s.toId,
        $amount: s.amountMinor,
        $cur: s.currency.toUpperCase(),
        $by: s.loggedBy ?? null,
        $at: s.at,
      });
    const id = Number(res.lastInsertRowid);
    appendJournal(db, {
      at: s.at,
      actorId: s.loggedBy ?? null,
      action: 'settlement.log',
      entity: `settlement:${id}`,
      before: null,
      after: db.query('SELECT * FROM settlements WHERE id = $id').get({ $id: id }),
    });
    return id;
  })();
}

/**
 * Wipe the ledger (expenses, shares, settlements). Config and journal survive —
 * the journal records the reset itself. Owner-only enforcement happens at the
 * agent layer; the core just requires an explicit actor and journals it.
 */
export function resetLedger(db: Database, actorId: number, at: string): void {
  const counts = {
    expenses: (db.query('SELECT COUNT(*) AS n FROM expenses').get() as { n: number }).n,
    settlements: (db.query('SELECT COUNT(*) AS n FROM settlements').get() as { n: number }).n,
  };
  db.transaction(() => {
    db.exec('DELETE FROM expense_shares; DELETE FROM expenses; DELETE FROM settlements;');
    appendJournal(db, {
      at, actorId, action: 'ledger.reset', entity: 'ledger', before: counts, after: { expenses: 0, settlements: 0 },
    });
  })();
}
