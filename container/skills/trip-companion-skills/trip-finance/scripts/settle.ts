export interface Transfer {
  from: number;
  to: number;
  amount: number; // minor units, always positive
}

/**
 * Greedy settlement minimization for one currency: repeatedly match the
 * largest debtor with the largest creditor. Settles k non-zero members in
 * at most k-1 transfers, conserves money exactly, and is deterministic
 * (ties broken by ascending member id).
 */
export function settlementPlan(net: Map<number, number>): Transfer[] {
  let creditTotal = 0;
  let debtTotal = 0;
  const creditors: { id: number; v: number }[] = [];
  const debtors: { id: number; v: number }[] = [];
  for (const [id, v] of net) {
    if (v > 0) {
      creditors.push({ id, v });
      creditTotal += v;
    } else if (v < 0) {
      debtors.push({ id, v: -v });
      debtTotal += -v;
    }
  }
  if (creditTotal !== debtTotal) {
    throw new Error(`unbalanced ledger: credit ${creditTotal} != debt ${debtTotal}`);
  }

  const byLargest = (a: { id: number; v: number }, b: { id: number; v: number }) =>
    b.v - a.v || a.id - b.id;
  const out: Transfer[] = [];
  while (creditors.length > 0 && debtors.length > 0) {
    creditors.sort(byLargest);
    debtors.sort(byLargest);
    const c = creditors[0];
    const d = debtors[0];
    const amount = Math.min(c.v, d.v);
    out.push({ from: d.id, to: c.id, amount });
    c.v -= amount;
    d.v -= amount;
    if (c.v === 0) creditors.shift();
    if (d.v === 0) debtors.shift();
  }
  return out;
}
