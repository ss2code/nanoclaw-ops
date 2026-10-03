import type { Database } from 'bun:sqlite';

// Deterministic plan-completeness gate (§8). Asserts the required must-have set
// (1–7, 9, 11, 13) is structurally present before `plan_ready` is allowed.
// Returns the exact missing slots — "good plan" becomes measurable coverage,
// not a vibe. URL-validity (§10) and feasibility (§8) are SEPARATE gates the CLI
// composes on top of this one.

const SLOTS = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'night'] as const;

export interface ValidationResult {
  ok: boolean;
  missing: string[];
}

export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const [y, m, d] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  const last = new Date(Date.UTC(ey, em - 1, ed));
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export function validatePlan(db: Database): ValidationResult {
  const missing: string[] = [];
  const all = <T>(sql: string, params: Record<string, unknown> = {}) => db.query(sql).all(params) as T[];

  // 1 · Trip frame
  const trip = db.query('SELECT name, base_currency, start_date, end_date, total_budget FROM trip WHERE id = 1').get() as
    | { name: string; base_currency: string; start_date: string | null; end_date: string | null; total_budget: number | null }
    | null;
  if (!trip) return { ok: false, missing: ['trip frame: not configured'] };
  if (!trip.start_date || !trip.end_date) missing.push('trip frame: start/end dates required');
  if (!trip.base_currency) missing.push('trip frame: base currency required');
  if (trip.total_budget == null) missing.push('trip frame: total budget required');

  // 2 · Route
  const committedDests = all<{ id: number; place_id: number | null; nights: number; order_index: number }>(
    "SELECT id, place_id, nights, order_index FROM destinations WHERE status = 'committed' ORDER BY order_index, id",
  );
  if (committedDests.length === 0) missing.push('route: at least one committed destination required');
  for (const d of committedDests) if (d.nights <= 0) missing.push(`route: destination ${d.id} needs nights`);

  // 3 · Per-person travel
  const travellers = all<{ id: number; display_name: string }>(
    `SELECT id, display_name FROM members
     WHERE left_at IS NULL
       AND id NOT IN (SELECT member_id FROM stage_participation WHERE stage = 'on_trip' AND status = 'out')
     ORDER BY id`,
  );
  for (const t of travellers) {
    const has = (dir: string) =>
      (db
        .query("SELECT COUNT(*) AS n FROM legs WHERE status = 'committed' AND member_id = $m AND direction = $d")
        .get({ $m: t.id, $d: dir }) as { n: number }).n > 0;
    if (!has('inbound')) missing.push(`travel: ${t.display_name} missing inbound leg`);
    if (!has('outbound')) missing.push(`travel: ${t.display_name} missing outbound leg`);
  }

  // 4 · Inter-destination transport (if multi-hop)
  if (committedDests.length >= 2) {
    for (let i = 0; i < committedDests.length - 1; i++) {
      const a = committedDests[i].place_id;
      const b = committedDests[i + 1].place_id;
      const hop = (db
        .query(
          "SELECT COUNT(*) AS n FROM transport_hops WHERE status = 'committed' AND from_place_id = $a AND to_place_id = $b",
        )
        .get({ $a: a, $b: b }) as { n: number }).n;
      if (hop === 0) missing.push(`transport: missing committed hop between destination ${i + 1} and ${i + 2}`);
    }
  }

  // 5 · Stays cover every night
  const tripNights = trip.start_date && trip.end_date ? Math.max(0, datesBetween(trip.start_date, trip.end_date).length - 1) : 0;
  const stayNights = (db.query("SELECT COALESCE(SUM(nights),0) AS n FROM stays WHERE status = 'committed'").get() as { n: number }).n;
  if (stayNights < tripNights) missing.push(`stays: committed stays cover ${stayNights} of ${tripNights} nights`);
  const destNights = committedDests.reduce((s, d) => s + d.nights, 0);
  if (committedDests.length > 0 && destNights !== tripNights) {
    missing.push(`route: destination nights (${destNights}) != trip length (${tripNights})`);
  }

  // 6 · Daily itinerary + 7 · Meals (per day from start→end)
  if (trip.start_date && trip.end_date) {
    for (const date of datesBetween(trip.start_date, trip.end_date)) {
      const day = db.query('SELECT id FROM days WHERE date = $d').get({ $d: date }) as { id: number } | null;
      if (!day) {
        missing.push(`day ${date}: no day planned`);
        continue;
      }
      for (const slot of SLOTS) {
        const n = (db
          .query("SELECT COUNT(*) AS n FROM itinerary_items WHERE day_id = $d AND slot = $s AND status = 'committed'")
          .get({ $d: day.id, $s: slot }) as { n: number }).n;
        if (n === 0) missing.push(`day ${date}: slot ${slot} unresolved`);
      }
      const mealCount = (slot: string) =>
        (db
          .query("SELECT COUNT(*) AS n FROM meals WHERE day_id = $d AND slot = $s AND status = 'committed'")
          .get({ $d: day.id, $s: slot }) as { n: number }).n;
      const breakfastIncl = (db
        .query("SELECT COUNT(*) AS n FROM meals WHERE day_id = $d AND slot = 'breakfast' AND status = 'committed' AND (included_in_stay = 1 OR cost IS NOT NULL)")
        .get({ $d: day.id }) as { n: number }).n;
      if (breakfastIncl === 0) missing.push(`meals ${date}: breakfast missing`);
      if (mealCount('lunch') < 2) missing.push(`meals ${date}: needs ≥2 lunch options`);
      if (mealCount('dinner') < 2) missing.push(`meals ${date}: needs ≥2 dinner options`);
    }
  }

  // 9 · Bookings ledger — every booking_required committed item/event has a deadline
  for (const it of all<{ title: string; ticket_deadline: string | null }>(
    "SELECT title, ticket_deadline FROM itinerary_items WHERE status = 'committed' AND booking_required = 1",
  )) {
    if (!it.ticket_deadline) missing.push(`bookings: "${it.title}" missing ticket deadline`);
  }
  for (const ev of all<{ title: string; ticket_deadline: string | null }>(
    "SELECT title, ticket_deadline FROM events WHERE status = 'committed' AND booking_required = 1",
  )) {
    if (!ev.ticket_deadline) missing.push(`bookings: event "${ev.title}" missing ticket deadline`);
  }

  // 11 · Cost present (or explicit free/included) in a known currency
  for (const l of all<{ id: number; cost: number | null }>("SELECT id, cost FROM legs WHERE status = 'committed'"))
    if (l.cost == null) missing.push(`cost: leg ${l.id} missing cost`);
  for (const h of all<{ id: number; cost: number | null }>("SELECT id, cost FROM transport_hops WHERE status = 'committed'"))
    if (h.cost == null) missing.push(`cost: hop ${h.id} missing cost`);
  for (const s of all<{ id: number; cost_per_night: number | null }>("SELECT id, cost_per_night FROM stays WHERE status = 'committed'"))
    if (s.cost_per_night == null) missing.push(`cost: stay ${s.id} missing cost`);
  for (const it of all<{ id: number; title: string; cost: number | null }>("SELECT id, title, cost FROM itinerary_items WHERE status = 'committed'"))
    if (it.cost == null) missing.push(`cost: item "${it.title}" missing cost`);
  for (const m of all<{ id: number; cost: number | null; included_in_stay: number }>("SELECT id, cost, included_in_stay FROM meals WHERE status = 'committed'"))
    if (m.cost == null && m.included_in_stay !== 1) missing.push(`cost: meal ${m.id} missing cost`);

  // 13 · Maps everywhere — every place referenced by a committed row carries a map link
  const referenced = new Set<number>();
  const collect = (sql: string) => {
    for (const r of all<Record<string, number | null>>(sql)) for (const v of Object.values(r)) if (v != null) referenced.add(v);
  };
  collect("SELECT place_id FROM destinations WHERE status = 'committed'");
  collect("SELECT place_id FROM stays WHERE status = 'committed'");
  collect("SELECT from_place_id, to_place_id FROM legs WHERE status = 'committed'");
  collect("SELECT place_id FROM itinerary_items WHERE status = 'committed'");
  collect("SELECT place_id FROM meals WHERE status = 'committed'");
  for (const pid of [...referenced].sort((a, b) => a - b)) {
    const p = db.query('SELECT name, map_url FROM places WHERE id = $id').get({ $id: pid }) as
      | { name: string; map_url: string | null }
      | null;
    if (p && !p.map_url) missing.push(`maps: "${p.name}" missing map link`);
  }

  return { ok: missing.length === 0, missing };
}
