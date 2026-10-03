import type { Database } from 'bun:sqlite';
import { formatMinor } from '../../trip-finance/scripts/money';
import { rollup } from './rollup';
import { datesBetween } from './validate';
import type { FeasibilityError } from './board';

// Deterministic feasibility — viability checked on every structural update (§8).
// Hard checks produce ERRORS that block plan_ready; soft checks produce WARNINGS
// that are surfaced but never block. The agent NEVER asserts feasibility itself
// — it calls this and relays the result (§10).

const SLOT_ORDER = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'night'];
const TIGHT_THRESHOLD_MIN = 15; // positive slack below this → soft warning

export interface CheckResult {
  errors: FeasibilityError[];
  warnings: FeasibilityError[];
}

function toMinutes(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function checkPlan(db: Database, opts?: { now?: string }): CheckResult {
  const errors: FeasibilityError[] = [];
  const warnings: FeasibilityError[] = [];
  const trip = db.query('SELECT start_date, end_date, total_budget, base_currency, pace_cap_minutes FROM trip WHERE id = 1').get() as
    | { start_date: string | null; end_date: string | null; total_budget: number | null; base_currency: string; pace_cap_minutes: number | null }
    | null;
  if (!trip) return { errors: [{ section: 'frame', message: 'trip not configured' }], warnings: [] };
  const now = opts?.now ?? trip.start_date ?? '1970-01-01';

  // ── Reachability / timing — consecutive committed items on each day ──
  const days = db.query('SELECT id, date FROM days ORDER BY date, id').all() as { id: number; date: string }[];
  for (const day of days) {
    const items = (
      db
        .query(
          "SELECT slot, start, end, title, travel_minutes FROM itinerary_items WHERE day_id = $d AND status = 'committed'",
        )
        .all({ $d: day.id }) as { slot: string; start: string | null; end: string | null; title: string; travel_minutes: number | null }[]
    ).sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || (toMinutes(a.start) ?? 0) - (toMinutes(b.start) ?? 0));
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const cur = items[i];
      const prevEnd = toMinutes(prev.end);
      const curStart = toMinutes(cur.start);
      if (prevEnd == null || curStart == null || cur.travel_minutes == null) continue;
      const slack = curStart - prevEnd - cur.travel_minutes;
      if (slack < 0) {
        errors.push({
          section: `day ${day.date}`,
          day: day.id,
          message: `Day ${day.date}: can't reach "${cur.title}" from "${prev.title}" in time — needs ${cur.travel_minutes}m travel but only ${curStart - prevEnd}m gap`,
        });
      } else if (slack < TIGHT_THRESHOLD_MIN) {
        warnings.push({
          section: `day ${day.date}`,
          day: day.id,
          message: `Day ${day.date}: tight connection to "${cur.title}" — ${slack}m margin after travel`,
        });
      }
    }
    const load = items.reduce((sum, item) => sum + (item.travel_minutes ?? 0) + ((toMinutes(item.end) != null && toMinutes(item.start) != null) ? Math.max(0, toMinutes(item.end)! - toMinutes(item.start)!) : 0), 0);
    if (trip.pace_cap_minutes != null && load > trip.pace_cap_minutes) {
      const fmt = (n: number) => n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? `${n % 60}m` : ''}` : `${n}m`;
      warnings.push({ section: `day ${day.date}`, day: day.id, message: `day ${day.date} load ≈ ${fmt(load)} exceeds pace cap ${fmt(trip.pace_cap_minutes)}` });
    }
  }

  // ── Opening hours — v1 is one daily HH:MM-HH:MM range. ──
  const openRows = db.query(`SELECT i.title,i.start,i.end,p.name,p.open_hours FROM itinerary_items i JOIN places p ON p.id=i.place_id WHERE i.status='committed' AND p.open_hours IS NOT NULL`).all() as { title: string; start: string | null; end: string | null; name: string; open_hours: string }[];
  for (const item of openRows) {
    const match = item.open_hours.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (!match || toMinutes(match[1]) == null || toMinutes(match[2]) == null) { warnings.push({ section: 'hours', message: `${item.name} has unparseable opening hours "${item.open_hours}"` }); continue; }
    const start = toMinutes(item.start); const end = toMinutes(item.end); const open = toMinutes(match[1])!; const close = toMinutes(match[2])!;
    if (start == null && end == null) warnings.push({ section: 'hours', message: `"${item.title}": place has opening hours but item is untimed` });
    else if ((start != null && start < open) || (end != null && end > close)) errors.push({ section: 'hours', message: `"${item.title}" is outside ${item.name} hours (${item.open_hours})` });
  }

  // ── Destination handoffs — warnings only because routing data is often incomplete. ──
  const destinations = db.query(`SELECT d.id,d.order_index,p.name,s.place_id,s.check_in,s.check_out FROM destinations d JOIN places p ON p.id=d.place_id JOIN stays s ON s.destination_id=d.id WHERE d.status='committed' AND s.status='committed' ORDER BY d.order_index,d.id`).all() as any[];
  for (let i = 1; i < destinations.length; i++) {
    const prev = destinations[i - 1]; const next = destinations[i];
    if (!prev.check_out || !next.check_in) continue;
    if (prev.check_out.slice(0, 10) > next.check_in.slice(0, 10)) warnings.push({ section: 'handoffs', message: `"${prev.name}" checkout overlaps "${next.name}" check-in` });
    const hop = db.query(`SELECT depart FROM transport_hops WHERE status='committed' AND ((from_place_id=$a AND to_place_id=$b) OR (from_place_id=$b AND to_place_id=$a)) ORDER BY id LIMIT 1`).get({ $a: prev.place_id, $b: next.place_id }) as { depart: string | null } | null;
    if (!hop) warnings.push({ section: 'handoffs', message: `no committed transport between "${prev.name}" and "${next.name}" (checkout ${prev.check_out.slice(0, 10)})` });
    else if (!hop.depart || hop.depart.slice(0, 10) !== prev.check_out.slice(0, 10)) warnings.push({ section: 'handoffs', message: `hop departs ${hop.depart?.slice(0, 10) ?? 'unknown'} but "${prev.name}" checkout is ${prev.check_out.slice(0, 10)}` });
  }

  // ── Sequence / dates — stays cover every night ──
  const tripNights = trip.start_date && trip.end_date ? Math.max(0, datesBetween(trip.start_date, trip.end_date).length - 1) : 0;
  const stayNights = (db.query("SELECT COALESCE(SUM(nights),0) AS n FROM stays WHERE status = 'committed'").get() as { n: number }).n;
  if (stayNights < tripNights) {
    errors.push({ section: 'stays', message: `${tripNights - stayNights} night(s) uncovered — committed stays cover ${stayNights} of ${tripNights}` });
  }

  // ── Budget — running base-currency total vs the cap ──
  if (trip.total_budget != null) {
    const r = rollup(db);
    if (r.budget && r.budget.withinBudget === false) {
      const over = r.budget.baseTotal - trip.total_budget;
      errors.push({
        section: 'budget',
        message: `over budget by ${formatMinor(over, trip.base_currency)} (committed ${formatMinor(r.budget.baseTotal, trip.base_currency)} vs cap ${formatMinor(trip.total_budget, trip.base_currency)})`,
      });
    }
  }

  // ── Deadlines — each booking_required committed item/event deadline must be future ──
  const deadlineRows = [
    ...(db
      .query("SELECT title, ticket_deadline FROM itinerary_items WHERE status = 'committed' AND booking_required = 1 AND ticket_deadline IS NOT NULL")
      .all() as { title: string; ticket_deadline: string }[]),
    ...(db
      .query("SELECT title, ticket_deadline FROM events WHERE status = 'committed' AND booking_required = 1 AND ticket_deadline IS NOT NULL")
      .all() as { title: string; ticket_deadline: string }[]),
  ];
  for (const d of deadlineRows) {
    if (d.ticket_deadline.slice(0, 10) < now.slice(0, 10)) {
      errors.push({ section: 'deadlines', message: `booking deadline for "${d.title}" has passed (${d.ticket_deadline})` });
    }
  }

  return { errors, warnings };
}
