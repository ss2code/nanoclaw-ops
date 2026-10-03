import type { Database } from 'bun:sqlite';
import { baseCurrency } from './db';

// Deterministic cost rollups (§8 must-have 11). The script owns every number
// (§10). Money is minor units (finance's model). Per-currency throughout —
// nothing is converted silently; the budget check is base-currency only and
// flags any non-base spend rather than inventing a rate.

type CurMap = Record<string, number>;

export interface Rollup {
  byCurrency: CurMap;
  perDay: Record<number, CurMap>;
  perPerson: Record<number, CurMap>;
  budget: {
    base: string;
    totalBudget: number | null;
    baseTotal: number;
    withinBudget: boolean | null;
    otherCurrencies: string[];
  } | null;
}

function add(map: CurMap, currency: string, amount: number | null): void {
  if (amount == null) return;
  map[currency] = (map[currency] ?? 0) + amount;
}

/** Active members (not left) — the headcount shared costs split across. */
function activeMemberIds(db: Database): number[] {
  return (db.query('SELECT id FROM members WHERE left_at IS NULL ORDER BY id').all() as { id: number }[]).map(
    (r) => r.id,
  );
}

export function rollup(db: Database, opts?: { statuses?: string[] }): Rollup {
  const statuses = opts?.statuses ?? ['committed'];
  const ph = statuses.map((_, i) => `$s${i}`).join(', ');
  const bind: Record<string, string> = {};
  statuses.forEach((s, i) => (bind[`$s${i}`] = s));

  const byCurrency: CurMap = {};
  const sharedByCurrency: CurMap = {};
  const perDay: Record<number, CurMap> = {};
  const perPerson: Record<number, CurMap> = {};

  const members = activeMemberIds(db);
  for (const m of members) perPerson[m] = {};

  // per-member legs
  for (const l of db
    .query(`SELECT member_id, cost, currency FROM legs WHERE status IN (${ph}) AND cost IS NOT NULL`)
    .all(bind) as { member_id: number | null; cost: number; currency: string }[]) {
    add(byCurrency, l.currency, l.cost);
    if (l.member_id != null && perPerson[l.member_id]) add(perPerson[l.member_id], l.currency, l.cost);
  }

  // shared: hops
  for (const h of db
    .query(`SELECT cost, currency FROM transport_hops WHERE status IN (${ph}) AND cost IS NOT NULL`)
    .all(bind) as { cost: number; currency: string }[]) {
    add(byCurrency, h.currency, h.cost);
    add(sharedByCurrency, h.currency, h.cost);
  }
  // shared: stays (cost_per_night × nights)
  for (const s of db
    .query(`SELECT cost_per_night, nights, currency FROM stays WHERE status IN (${ph}) AND cost_per_night IS NOT NULL`)
    .all(bind) as { cost_per_night: number; nights: number | null; currency: string }[]) {
    const total = s.cost_per_night * (s.nights ?? 0);
    add(byCurrency, s.currency, total);
    add(sharedByCurrency, s.currency, total);
  }
  // shared: itinerary items
  for (const it of db
    .query(`SELECT day_id, cost, currency FROM itinerary_items WHERE status IN (${ph}) AND cost IS NOT NULL`)
    .all(bind) as { day_id: number; cost: number; currency: string }[]) {
    add(byCurrency, it.currency, it.cost);
    add(sharedByCurrency, it.currency, it.cost);
    perDay[it.day_id] ??= {};
    add(perDay[it.day_id], it.currency, it.cost);
  }
  // shared: meals
  for (const ml of db
    .query(`SELECT day_id, cost, currency FROM meals WHERE status IN (${ph}) AND cost IS NOT NULL`)
    .all(bind) as { day_id: number; cost: number; currency: string }[]) {
    add(byCurrency, ml.currency, ml.cost);
    add(sharedByCurrency, ml.currency, ml.cost);
    perDay[ml.day_id] ??= {};
    add(perDay[ml.day_id], ml.currency, ml.cost);
  }
  // shared: events
  for (const ev of db
    .query(`SELECT cost, currency FROM events WHERE status IN (${ph}) AND cost IS NOT NULL`)
    .all(bind) as { cost: number; currency: string }[]) {
    add(byCurrency, ev.currency, ev.cost);
    add(sharedByCurrency, ev.currency, ev.cost);
  }

  // split shared equally across active members (estimate — exact split is finance's job)
  const headcount = members.length || 1;
  for (const [cur, total] of Object.entries(sharedByCurrency)) {
    const share = Math.floor(total / headcount);
    let crumb = total - share * headcount;
    for (const m of members) {
      add(perPerson[m], cur, share + (crumb > 0 ? 1 : 0));
      if (crumb > 0) crumb--;
    }
  }

  const base = baseCurrency(db);
  const tb = db.query('SELECT total_budget FROM trip WHERE id = 1').get() as { total_budget: number | null } | null;
  const baseTotal = byCurrency[base] ?? 0;
  const otherCurrencies = Object.keys(byCurrency).filter((c) => c !== base).sort();
  const budget = {
    base,
    totalBudget: tb?.total_budget ?? null,
    baseTotal,
    withinBudget: tb?.total_budget != null ? baseTotal <= tb.total_budget : null,
    otherCurrencies,
  };

  return { byCurrency, perDay, perPerson, budget };
}
