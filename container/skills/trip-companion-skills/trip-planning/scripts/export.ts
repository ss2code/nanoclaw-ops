import type { Database } from 'bun:sqlite';
import { formatMinor } from '../../trip-finance/scripts/money';
import { rollup } from './rollup';

// The downloadable plan (§18). At plan_ready the validated committed set renders
// to a self-contained HTML document — route, per-person travel, stays, the full
// dawn-to-dusk itinerary, bookings ledger, cost rollup, every item linked —
// watermarked via a one-line constant. A DRAFT variant is available anytime.

export const WATERMARK = 'Generated through KDtravelApp';

const SLOT_ORDER = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'night'];

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function placeMap(db: Database): Map<number, { name: string; map_url: string | null }> {
  const m = new Map<number, { name: string; map_url: string | null }>();
  for (const p of db.query('SELECT id, name, map_url FROM places').all() as { id: number; name: string; map_url: string | null }[]) {
    m.set(p.id, { name: p.name, map_url: p.map_url });
  }
  return m;
}

function link(place: { name: string; map_url: string | null } | undefined): string {
  if (!place) return '—';
  return place.map_url ? `<a href="${esc(place.map_url)}">${esc(place.name)}</a>` : esc(place.name);
}

function cost(amount: number | null, currency: string | null, base: string): string {
  if (amount == null) return '—';
  return formatMinor(amount, currency ?? base);
}

/** Freeze the committed set into a plan_versions snapshot; returns the new version number. */
export function snapshotPlan(db: Database, validated: boolean, at: string): number {
  const committed = <T>(table: string) => db.query(`SELECT * FROM ${table} WHERE status = 'committed'`).all() as T[];
  const summary = {
    trip: db.query('SELECT * FROM trip WHERE id = 1').get(),
    destinations: committed('destinations'),
    legs: committed('legs'),
    transport_hops: committed('transport_hops'),
    stays: committed('stays'),
    days: db.query('SELECT * FROM days').all(),
    itinerary_items: committed('itinerary_items'),
    meals: committed('meals'),
    events: committed('events'),
  };
  const maxV = (db.query('SELECT COALESCE(MAX(version),0) AS v FROM plan_versions').get() as { v: number }).v;
  const version = maxV + 1;
  db.query('INSERT INTO plan_versions (version, created_at, summary_json, validated) VALUES ($v, $at, $s, $val)').run({
    $v: version,
    $at: at,
    $s: JSON.stringify(summary),
    $val: validated ? 1 : 0,
  });
  return version;
}

export function exportPlan(db: Database, opts?: { draft?: boolean }): string {
  const trip = db.query('SELECT name, base_currency, start_date, end_date, total_budget FROM trip WHERE id = 1').get() as
    | { name: string; base_currency: string; start_date: string | null; end_date: string | null; total_budget: number | null }
    | null;
  const base = trip?.base_currency ?? 'INR';
  const places = placeMap(db);
  const memberName = new Map(
    (db.query('SELECT id, display_name FROM members').all() as { id: number; display_name: string }[]).map((m) => [m.id, m.display_name]),
  );
  const sections: string[] = [];

  // Route
  const dests = db
    .query("SELECT place_id, nights, rationale FROM destinations WHERE status = 'committed' ORDER BY order_index, id")
    .all() as { place_id: number | null; nights: number; rationale: string | null }[];
  sections.push(
    `<h2>Route</h2><ul>${dests
      .map((d) => `<li>${link(places.get(d.place_id ?? -1))} — ${d.nights} night(s)${d.rationale ? ` · ${esc(d.rationale)}` : ''}</li>`)
      .join('')}</ul>`,
  );

  // Per-person travel
  const legs = db
    .query("SELECT member_id, from_place_id, to_place_id, mode, depart, arrive, cost, currency, booking_url, direction FROM legs WHERE status = 'committed' ORDER BY member_id, id")
    .all() as any[];
  sections.push(
    `<h2>Getting there &amp; back</h2><ul>${legs
      .map(
        (l) =>
          `<li><b>${esc(memberName.get(l.member_id) ?? '—')}</b> (${esc(l.direction ?? '')}): ${esc(l.mode ?? '')} ${link(places.get(l.from_place_id))} → ${link(places.get(l.to_place_id))} · ${cost(l.cost, l.currency, base)}${l.booking_url ? ` · <a href="${esc(l.booking_url)}">book</a>` : ''}</li>`,
      )
      .join('')}</ul>`,
  );

  // Stays
  const stays = db
    .query("SELECT place_id, tier, check_in, check_out, nights, cost_per_night, currency, booking_url FROM stays WHERE status = 'committed' ORDER BY id")
    .all() as any[];
  sections.push(
    `<h2>Where you sleep</h2><ul>${stays
      .map(
        (s) =>
          `<li>${link(places.get(s.place_id))}${s.tier ? ` (${esc(s.tier)})` : ''} · ${esc(s.check_in)}→${esc(s.check_out)}, ${s.nights} night(s) · ${cost(s.cost_per_night, s.currency, base)}/night${s.booking_url ? ` · <a href="${esc(s.booking_url)}">book</a>` : ''}</li>`,
      )
      .join('')}</ul>`,
  );

  // Daily itinerary
  const days = db.query('SELECT id, date, theme FROM days ORDER BY date, id').all() as { id: number; date: string; theme: string | null }[];
  const dayBlocks = days.map((day) => {
    const items = (
      db
        .query("SELECT slot, start, end, place_id, title, travel_minutes, travel_mode, cost, currency, booking_required, ticket_deadline, info_url FROM itinerary_items WHERE day_id = $d AND status = 'committed'")
        .all({ $d: day.id }) as any[]
    ).sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
    const rows = items
      .map(
        (it) =>
          `<tr><td>${esc(it.slot)}</td><td>${esc(it.start ?? '')}${it.end ? `–${esc(it.end)}` : ''}</td><td>${esc(it.title)}${it.info_url ? ` <a href="${esc(it.info_url)}">[link]</a>` : ''} ${link(places.get(it.place_id))}</td><td>${it.travel_minutes != null ? `${esc(it.travel_mode ?? '')} ${it.travel_minutes}m` : '—'}</td><td>${cost(it.cost, it.currency, base)}</td><td>${it.booking_required ? `book by ${esc(it.ticket_deadline ?? '?')}` : '—'}</td></tr>`,
      )
      .join('');
    const meals = db
      .query("SELECT slot, place_id, cost, currency, url, included_in_stay FROM meals WHERE day_id = $d AND status = 'committed' ORDER BY slot")
      .all({ $d: day.id }) as any[];
    const mealList = meals
      .map((m) => `<li>${esc(m.slot)}: ${m.included_in_stay ? 'included' : link(places.get(m.place_id))}${m.url ? ` <a href="${esc(m.url)}">[menu]</a>` : ''} ${m.included_in_stay ? '' : `· ${cost(m.cost, m.currency, base)}`}</li>`)
      .join('');
    return `<h3>${esc(day.date)}${day.theme ? ` — ${esc(day.theme)}` : ''}</h3>
      <table><thead><tr><th>Slot</th><th>Time</th><th>What</th><th>Travel</th><th>Cost</th><th>Book?</th></tr></thead><tbody>${rows}</tbody></table>
      <p><b>Meals:</b></p><ul>${mealList}</ul>`;
  });
  sections.push(`<h2>Every day, dawn to dusk</h2>${dayBlocks.join('')}`);

  // Bookings ledger
  const bookings = [
    ...(db.query("SELECT title, ticket_deadline, booking_url FROM itinerary_items WHERE status = 'committed' AND booking_required = 1").all() as any[]),
    ...(db.query("SELECT title, ticket_deadline, source_url AS booking_url FROM events WHERE status = 'committed' AND booking_required = 1").all() as any[]),
  ];
  sections.push(
    `<h2>Bookings ledger — book by the deadline</h2><ul>${bookings
      .map((b) => `<li>${esc(b.title)} — by <b>${esc(b.ticket_deadline ?? '?')}</b>${b.booking_url ? ` · <a href="${esc(b.booking_url)}">book</a>` : ''}</li>`)
      .join('') || '<li>nothing to pre-book</li>'}</ul>`,
  );

  // Cost rollup
  const r = rollup(db);
  const totals = Object.entries(r.byCurrency).map(([c, v]) => formatMinor(v, c)).join(' · ') || '—';
  sections.push(
    `<h2>The money</h2><p>Total: ${esc(totals)}${trip?.total_budget != null ? ` · budget ${formatMinor(trip.total_budget, base)}` : ''}</p>
     <ul>${Object.entries(r.perPerson)
       .map(([m, cur]) => `<li>${esc(memberName.get(Number(m)) ?? `#${m}`)}: ${Object.entries(cur).map(([c, v]) => formatMinor(v, c)).join(' · ') || '—'}</li>`)
       .join('')}</ul>`,
  );

  const draftBanner = opts?.draft ? `<div style="background:#faf2d6;border:1px solid #ecd98c;padding:8px 14px;border-radius:8px;font-weight:700;color:#7a5c00">DRAFT — not locked</div>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(trip?.name ?? 'Trip')} — Plan</title>
<style>
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:880px;margin:0 auto;padding:32px 24px;color:#22262f}
h1{font-size:28px}h2{border-bottom:2px solid #e8e3da;padding-bottom:6px;margin-top:32px}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13.5px}
th,td{text-align:left;padding:6px 9px;border-bottom:1px solid #eee;vertical-align:top}
th{background:#f2efe9}a{color:#0d7d8a}
.wm{margin-top:40px;color:#9aa;font-size:12px;border-top:1px solid #e8e3da;padding-top:12px}
</style></head><body>
${draftBanner}
<h1>${esc(trip?.name ?? 'Trip')}</h1>
<p>${esc(trip?.start_date ?? '')} → ${esc(trip?.end_date ?? '')}</p>
${sections.join('\n')}
<p class="wm">${esc(WATERMARK)}</p>
</body></html>`;
}
