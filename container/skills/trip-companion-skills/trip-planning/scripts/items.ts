import type { Database } from 'bun:sqlite';
import { appendJournal } from '../../trip-core/scripts/db';
import { PLAN_STATUSES, PLAN_TABLES, type PlanStatus, type PlanTable, baseCurrency } from './db';

// CRUD for the plan model (§7). Each row starts as `candidate`; cost is minor
// units (finance money model) and currency defaults to the trip base when
// omitted. setStatus walks the proposal lifecycle and journals it.

const bool = (b: boolean | undefined): number => (b ? 1 : 0);

function journalAdd(db: Database, table: string, id: number, actorId: number | null, at: string, summary: unknown): void {
  appendJournal(db, { at, actorId, action: `plan.${table}.add`, entity: `${table}:${id}`, before: null, after: summary });
}

export function addDestination(
  db: Database,
  d: { placeId: number; orderIndex: number; nights: number; rationale?: string | null; trivia?: string | null },
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query('INSERT INTO destinations (place_id, order_index, nights, rationale, trivia) VALUES ($p, $o, $n, $r, $t)')
    .run({ $p: d.placeId, $o: d.orderIndex, $n: d.nights, $r: d.rationale ?? null, $t: d.trivia ?? null });
  const id = Number(res.lastInsertRowid);
  journalAdd(db, 'destinations', id, actorId, at, { id, place_id: d.placeId, nights: d.nights });
  return id;
}

export function addLeg(
  db: Database,
  l: {
    memberId?: number | null;
    fromPlaceId?: number | null;
    toPlaceId?: number | null;
    mode?: string | null;
    carrier?: string | null;
    depart?: string | null;
    arrive?: string | null;
    cost?: number | null;
    currency?: string | null;
    bookingUrl?: string | null;
    ref?: string | null;
    direction?: string | null;
  },
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query(
      `INSERT INTO legs (member_id, from_place_id, to_place_id, mode, carrier, depart, arrive, cost, currency, booking_url, ref, direction)
       VALUES ($m, $f, $t, $mo, $ca, $de, $ar, $co, $cu, $bu, $rf, $di)`,
    )
    .run({
      $m: l.memberId ?? null,
      $f: l.fromPlaceId ?? null,
      $t: l.toPlaceId ?? null,
      $mo: l.mode ?? null,
      $ca: l.carrier ?? null,
      $de: l.depart ?? null,
      $ar: l.arrive ?? null,
      $co: l.cost ?? null,
      $cu: l.currency ?? baseCurrency(db),
      $bu: l.bookingUrl ?? null,
      $rf: l.ref ?? null,
      $di: l.direction ?? null,
    });
  const id = Number(res.lastInsertRowid);
  journalAdd(db, 'legs', id, actorId, at, { id, member_id: l.memberId ?? null, direction: l.direction ?? null });
  return id;
}

export function addHop(
  db: Database,
  h: {
    fromPlaceId?: number | null;
    toPlaceId?: number | null;
    mode?: string | null;
    depart?: string | null;
    arrive?: string | null;
    travelMinutes?: number | null;
    cost?: number | null;
    currency?: string | null;
    bookingUrl?: string | null;
    buffer?: number | null;
  },
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query(
      `INSERT INTO transport_hops (from_place_id, to_place_id, mode, depart, arrive, travel_minutes, cost, currency, booking_url, buffer)
       VALUES ($f, $t, $mo, $de, $ar, $tm, $co, $cu, $bu, $bf)`,
    )
    .run({
      $f: h.fromPlaceId ?? null,
      $t: h.toPlaceId ?? null,
      $mo: h.mode ?? null,
      $de: h.depart ?? null,
      $ar: h.arrive ?? null,
      $tm: h.travelMinutes ?? null,
      $co: h.cost ?? null,
      $cu: h.currency ?? baseCurrency(db),
      $bu: h.bookingUrl ?? null,
      $bf: h.buffer ?? null,
    });
  const id = Number(res.lastInsertRowid);
  journalAdd(db, 'transport_hops', id, actorId, at, { id });
  return id;
}

export function addStay(
  db: Database,
  s: {
    destinationId?: number | null;
    placeId: number;
    tier?: string | null;
    checkIn: string;
    checkOut: string;
    nights: number;
    costPerNight?: number | null;
    currency?: string | null;
    breakfastIncluded?: boolean;
    bookingUrl?: string | null;
    ref?: string | null;
  },
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query(
      `INSERT INTO stays (destination_id, place_id, tier, check_in, check_out, nights, cost_per_night, currency, breakfast_included, booking_url, ref)
       VALUES ($d, $p, $ti, $ci, $co, $n, $cpn, $cu, $bi, $bu, $ref)`,
    )
    .run({
      $d: s.destinationId ?? null,
      $p: s.placeId,
      $ti: s.tier ?? null,
      $ci: s.checkIn,
      $co: s.checkOut,
      $n: s.nights,
      $cpn: s.costPerNight ?? null,
      $cu: s.currency ?? baseCurrency(db),
      $bi: bool(s.breakfastIncluded),
      $bu: s.bookingUrl ?? null,
      $ref: s.ref ?? null,
    });
  const id = Number(res.lastInsertRowid);
  journalAdd(db, 'stays', id, actorId, at, { id, place_id: s.placeId, nights: s.nights });
  return id;
}

export function addDay(
  db: Database,
  d: { date: string; basePlaceId?: number | null; theme?: string | null },
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query('INSERT INTO days (date, base_place_id, theme) VALUES ($d, $b, $t)')
    .run({ $d: d.date, $b: d.basePlaceId ?? null, $t: d.theme ?? null });
  const id = Number(res.lastInsertRowid);
  journalAdd(db, 'days', id, actorId, at, { id, date: d.date });
  return id;
}

export function addItem(
  db: Database,
  it: {
    dayId: number;
    slot: string;
    start?: string | null;
    end?: string | null;
    placeId?: number | null;
    type?: string;
    title: string;
    travelFromPlaceId?: number | null;
    travelMode?: string | null;
    travelMinutes?: number | null;
    cost?: number | null;
    currency?: string | null;
    bookingRequired?: boolean;
    bookingUrl?: string | null;
    ticketDeadline?: string | null;
    infoUrl?: string | null;
    notes?: string | null;
    alternateForItemId?: number | null;
  },
  actorId: number | null,
  at: string,
): number {
  let inherited: { day_id: number; slot: string; alternate_for_item_id: number | null } | null = null;
  if (it.alternateForItemId != null) {
    inherited = db.query('SELECT day_id,slot,alternate_for_item_id FROM itinerary_items WHERE id=$id').get({ $id: it.alternateForItemId }) as typeof inherited;
    if (!inherited) throw new Error(`alternate target item ${it.alternateForItemId} not found`);
    if (inherited.alternate_for_item_id != null) throw new Error('an alternate cannot itself have an alternate');
  }
  const res = db
    .query(
      `INSERT INTO itinerary_items
        (day_id, slot, start, end, place_id, type, title, travel_from_place_id, travel_mode, travel_minutes,
         cost, currency, booking_required, booking_url, ticket_deadline, info_url, notes, alternate_for_item_id, status)
       VALUES ($d, $sl, $st, $en, $p, $ty, $ti, $tf, $tm, $tmin, $co, $cu, $br, $bu, $td, $iu, $no, $alt, $status)`,
    )
    .run({
      $d: inherited?.day_id ?? it.dayId,
      $sl: inherited?.slot ?? it.slot,
      $st: it.start ?? null,
      $en: it.end ?? null,
      $p: it.placeId ?? null,
      $ty: it.type ?? 'activity',
      $ti: it.title,
      $tf: it.travelFromPlaceId ?? null,
      $tm: it.travelMode ?? null,
      $tmin: it.travelMinutes ?? null,
      $co: it.cost ?? null,
      $cu: it.currency ?? baseCurrency(db),
      $br: bool(it.bookingRequired),
      $bu: it.bookingUrl ?? null,
      $td: it.ticketDeadline ?? null,
      $iu: it.infoUrl ?? null,
      $no: it.notes ?? null,
      $alt: it.alternateForItemId ?? null,
      $status: it.alternateForItemId != null ? 'candidate' : 'candidate',
    });
  const id = Number(res.lastInsertRowid);
  journalAdd(db, 'itinerary_items', id, actorId, at, { id, day_id: it.dayId, slot: it.slot, title: it.title });
  return id;
}

export function addMeal(
  db: Database,
  m: {
    dayId: number;
    slot: string;
    placeId?: number | null;
    vegOk?: boolean;
    cost?: number | null;
    currency?: string | null;
    url?: string | null;
    includedInStay?: boolean;
  },
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query(
      `INSERT INTO meals (day_id, slot, place_id, veg_ok, cost, currency, url, included_in_stay)
       VALUES ($d, $sl, $p, $v, $co, $cu, $u, $inc)`,
    )
    .run({
      $d: m.dayId,
      $sl: m.slot,
      $p: m.placeId ?? null,
      $v: m.vegOk === false ? 0 : 1,
      $co: m.cost ?? null,
      $cu: m.currency ?? baseCurrency(db),
      $u: m.url ?? null,
      $inc: bool(m.includedInStay),
    });
  const id = Number(res.lastInsertRowid);
  journalAdd(db, 'meals', id, actorId, at, { id, day_id: m.dayId, slot: m.slot });
  return id;
}

export function addEvent(
  db: Database,
  e: {
    date: string;
    placeId?: number | null;
    title: string;
    kind?: string;
    sourceUrl?: string | null;
    bookingRequired?: boolean;
    ticketDeadline?: string | null;
    cost?: number | null;
    currency?: string | null;
  },
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query(
      `INSERT INTO events (date, place_id, title, kind, source_url, booking_required, ticket_deadline, cost, currency)
       VALUES ($d, $p, $ti, $k, $s, $br, $td, $co, $cu)`,
    )
    .run({
      $d: e.date,
      $p: e.placeId ?? null,
      $ti: e.title,
      $k: e.kind ?? 'attend',
      $s: e.sourceUrl ?? null,
      $br: bool(e.bookingRequired),
      $td: e.ticketDeadline ?? null,
      $co: e.cost ?? null,
      $cu: e.currency ?? baseCurrency(db),
    });
  const id = Number(res.lastInsertRowid);
  journalAdd(db, 'events', id, actorId, at, { id, title: e.title, kind: e.kind ?? 'attend' });
  return id;
}

export function setStatus(
  db: Database,
  table: PlanTable,
  id: number,
  status: PlanStatus,
  actorId: number | null,
  at: string,
): void {
  if (!PLAN_TABLES.includes(table)) throw new Error(`unknown table "${table}"`);
  if (!PLAN_STATUSES.includes(status)) throw new Error(`unknown status "${status}"`);
  const before = db.query(`SELECT status FROM ${table} WHERE id = $id`).get({ $id: id }) as { status: string } | null;
  if (!before) throw new Error(`${table} ${id} not found`);
  db.query(`UPDATE ${table} SET status = $s WHERE id = $id`).run({ $s: status, $id: id });
  appendJournal(db, {
    at,
    actorId,
    action: `plan.${table}.status`,
    entity: `${table}:${id}`,
    before,
    after: { status },
  });
}
