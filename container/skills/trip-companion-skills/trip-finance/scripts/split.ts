import { assertMinor } from './money';

export type SplitRule = 'equal-all' | 'by-family' | 'custom';

/**
 * Structured custom-split spec. Translating natural language ("60/40 between
 * families, exclude the kids") into one of these is the LLM's job; this module
 * only validates and computes. Unit keys are 'f<familyId>' for families and
 * 'm<memberId>' for standalone individuals.
 */
export type CustomSpec =
  | { kind: 'exclude'; memberIds: number[] } // equal-all among remaining participants
  | { kind: 'explicit'; shares: Record<string, number> } // memberId -> minor units, must sum to amount
  | { kind: 'ratio-by-unit'; weights: Record<string, number> } // units absent from weights are excluded
  | { kind: 'ratio-by-member'; weights: Record<string, number> }; // members absent are excluded

export interface Participant {
  id: number;
  familyId: number | null;
}

/**
 * Rounding-crumb policy (documented invariant — golden tests depend on it):
 * shares are floor-divided; if the payer is among the recipients, the payer
 * absorbs the entire crumb ("payer absorbs the rounding crumb", design §3);
 * otherwise the first `crumb` recipients in ascending-id order get +1 each.
 * Either way sum(shares) === amount exactly.
 */
function distribute(amount: number, ids: number[], preferredId: number | null): Map<number, number> {
  if (ids.length === 0) throw new Error('no participants to split among');
  const sorted = [...ids].sort((a, b) => a - b);
  const base = Math.floor(amount / sorted.length);
  let crumb = amount - base * sorted.length;
  const out = new Map<number, number>(sorted.map((id) => [id, base]));
  if (crumb > 0) {
    if (preferredId !== null && out.has(preferredId)) {
      out.set(preferredId, base + crumb);
    } else {
      for (const id of sorted) {
        if (crumb === 0) break;
        out.set(id, out.get(id)! + 1);
        crumb--;
      }
    }
  }
  return out;
}

/** Same crumb policy, but over ordered positions instead of member ids. */
function distributeOrdered(amount: number, n: number, preferredIdx: number): number[] {
  if (n === 0) throw new Error('no units to split among');
  const base = Math.floor(amount / n);
  let crumb = amount - base * n;
  const out: number[] = Array(n).fill(base);
  if (crumb > 0) {
    if (preferredIdx >= 0) {
      out[preferredIdx] += crumb;
    } else {
      for (let i = 0; i < n && crumb > 0; i++) {
        out[i]++;
        crumb--;
      }
    }
  }
  return out;
}

interface Unit {
  key: string;
  order: number; // smallest member id in the unit — defines unit ordering
  memberIds: number[];
}

/** Families are one unit each; standalone individuals are their own unit. */
function groupUnits(participants: Participant[]): Unit[] {
  const byFamily = new Map<number, number[]>();
  const units: Unit[] = [];
  for (const p of participants) {
    if (p.familyId == null) {
      units.push({ key: `m${p.id}`, order: p.id, memberIds: [p.id] });
    } else {
      const arr = byFamily.get(p.familyId) ?? [];
      arr.push(p.id);
      byFamily.set(p.familyId, arr);
    }
  }
  for (const [fid, ids] of byFamily) {
    units.push({ key: `f${fid}`, order: Math.min(...ids), memberIds: ids.sort((a, b) => a - b) });
  }
  units.sort((a, b) => a.order - b.order);
  return units;
}

function splitWithinUnits(units: Unit[], unitAmounts: number[], payerId: number): Map<number, number> {
  const out = new Map<number, number>();
  units.forEach((u, i) => {
    if (unitAmounts[i] === 0 && u.memberIds.length === 0) return;
    const inner = distribute(unitAmounts[i], u.memberIds, u.memberIds.includes(payerId) ? payerId : null);
    for (const [id, v] of inner) out.set(id, v);
  });
  return out;
}

function ratioFloors(amount: number, weights: number[]): number[] {
  const W = weights.reduce((a, b) => a + b, 0);
  if (W <= 0) throw new Error('ratio weights must sum to a positive number');
  return weights.map((w) => Math.floor((amount * w) / W));
}

export function computeShares(opts: {
  amountMinor: number;
  rule: SplitRule;
  custom?: CustomSpec | null;
  payerId: number;
  /** Active, non-excluded members as of the expense date — the automatic split pool. */
  participants: Participant[];
  /** Member ids that may receive explicit shares (defaults to participants). */
  explicitEligible?: Set<number>;
}): Map<number, number> {
  const { amountMinor, rule, custom, payerId, participants } = opts;
  assertMinor(amountMinor, 'expense amount');
  if (amountMinor <= 0) throw new Error(`expense amount must be positive, got ${amountMinor}`);

  if (rule === 'equal-all') {
    return distribute(amountMinor, participants.map((p) => p.id), payerId);
  }

  if (rule === 'by-family') {
    const units = groupUnits(participants);
    const payerUnitIdx = units.findIndex((u) => u.memberIds.includes(payerId));
    const unitAmounts = distributeOrdered(amountMinor, units.length, payerUnitIdx);
    return splitWithinUnits(units, unitAmounts, payerId);
  }

  // rule === 'custom'
  if (!custom) throw new Error('custom split requires a custom spec');

  switch (custom.kind) {
    case 'exclude': {
      const excluded = new Set(custom.memberIds);
      const remaining = participants.filter((p) => !excluded.has(p.id));
      return distribute(amountMinor, remaining.map((p) => p.id), payerId);
    }

    case 'explicit': {
      const eligible = opts.explicitEligible ?? new Set(participants.map((p) => p.id));
      const out = new Map<number, number>();
      let sum = 0;
      for (const [idStr, share] of Object.entries(custom.shares)) {
        const id = Number(idStr);
        assertMinor(share, `explicit share for member ${id}`);
        if (share <= 0) throw new Error(`explicit share for member ${id} must be positive`);
        if (!eligible.has(id)) throw new Error(`member ${id} is not eligible for a share on this date`);
        out.set(id, share);
        sum += share;
      }
      if (out.size === 0) throw new Error('explicit split needs at least one share');
      if (sum !== amountMinor) {
        throw new Error(`explicit shares sum to ${sum}, expense amount is ${amountMinor}`);
      }
      return out;
    }

    case 'ratio-by-unit': {
      const units = groupUnits(participants).filter((u) => custom.weights[u.key] !== undefined);
      if (units.length === 0) throw new Error('ratio-by-unit weights match no active units');
      const weights = units.map((u) => {
        const w = custom.weights[u.key];
        if (!(Number.isFinite(w) && w > 0)) throw new Error(`weight for unit ${u.key} must be > 0`);
        return w;
      });
      const floors = ratioFloors(amountMinor, weights);
      let crumb = amountMinor - floors.reduce((a, b) => a + b, 0);
      if (crumb > 0) {
        const payerUnitIdx = units.findIndex((u) => u.memberIds.includes(payerId));
        if (payerUnitIdx >= 0) {
          floors[payerUnitIdx] += crumb;
        } else {
          for (let i = 0; i < floors.length && crumb > 0; i++) {
            floors[i]++;
            crumb--;
          }
        }
      }
      return splitWithinUnits(units, floors, payerId);
    }

    case 'ratio-by-member': {
      const pool = new Map(participants.map((p) => [p.id, p]));
      const entries = Object.entries(custom.weights)
        .map(([idStr, w]) => ({ id: Number(idStr), w }))
        .sort((a, b) => a.id - b.id);
      if (entries.length === 0) throw new Error('ratio-by-member needs at least one weight');
      for (const { id, w } of entries) {
        if (!pool.has(id)) throw new Error(`member ${id} is not an active participant on this date`);
        if (!(Number.isFinite(w) && w > 0)) throw new Error(`weight for member ${id} must be > 0`);
      }
      const floors = ratioFloors(amountMinor, entries.map((e) => e.w));
      let crumb = amountMinor - floors.reduce((a, b) => a + b, 0);
      if (crumb > 0) {
        const payerIdx = entries.findIndex((e) => e.id === payerId);
        if (payerIdx >= 0) {
          floors[payerIdx] += crumb;
        } else {
          for (let i = 0; i < floors.length && crumb > 0; i++) {
            floors[i]++;
            crumb--;
          }
        }
      }
      return new Map(entries.map((e, i) => [e.id, floors[i]]));
    }

    default:
      throw new Error(`unknown custom split kind: ${(custom as { kind: string }).kind}`);
  }
}
