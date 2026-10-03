// compose.ts — deterministic generator for the trip MASTER document. Merges two
// content classes into one canonical HTML file:
//
//   structural sections — rendered from trip.db (route strip, geographic map,
//     calendar ribbon, travel legs, segments, stays, budget, day-by-day, ops tab).
//     Wrapped in <!-- gen:name sha256=… --> regions; hand-edits inside a region are
//     REFUSED so churn always flows through trip-planning/trip-core, never the file.
//   prose blocks — authored fragments in blocks/<slug>/*.html slotted into
//     <!-- prose:name --> markers (intro, options, sights, food, weather, packing).
//
// The hybrid map contract: the schematic SVG route strip is ALWAYS emitted (inline,
// zero network — it is the map the PDF carries, since render.ts prints over file://
// with no network). The geographic Leaflet map is emitted only for --hosted output:
// Leaflet loads from unpkg pinned to 1.9.4 with verified SRI hashes (the hosted page
// already depends on the network for OSM tiles, so a pinned+SRI CDN adds no new
// fragility), markers are circleMarkers (no icon assets), and @media print hides it.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSectionMarkers, scaffold, summarize, restoreHistory } from './docs';
import { formatMinor } from '../../trip-finance/scripts/money';

type Row = Record<string, any>;

export interface ComposeOptions {
  dbPath: string;
  slug: string;
  dir: string;
  date: string;
  hosted?: boolean;
  /** Regenerate the shell from the current scaffold (template upgrade), preserving
   *  version + revision history and re-applying prose blocks. */
  rebuild?: boolean;
}

export interface ComposeResult {
  file: string;
  path: string;
  version: number;
  warnings: string[];
}

const SLOT_ORDER = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'night'];
const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const RIBBON_PALETTE = ['#2c6fb0', '#2b8a57', '#6d4fc4', '#b07f24', '#b04a6e', '#1f7a8c'];
const MODE_GLYPHS: [RegExp, string][] = [
  [/fly|flight|plane|air/i, '✈️'],
  [/train|rail/i, '🚆'],
  [/ferry|boat/i, '⛴️'],
  [/bus|coach/i, '🚌'],
  [/walk|hike/i, '🚶'],
  [/drive|car|taxi|cab/i, '🚗'],
];

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function slugText(v: unknown): string {
  return String(v ?? 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function all<T extends Row>(db: Database, sql: string, bind?: Row): T[] {
  try {
    return (bind ? db.query(sql).all(bind) : db.query(sql).all()) as T[];
  } catch {
    return [];
  }
}

function one<T extends Row>(db: Database, sql: string, bind?: Row): T | null {
  try {
    return (bind ? db.query(sql).get(bind) : db.query(sql).get()) as T | null;
  } catch {
    return null;
  }
}

function region(name: string, content: string): string {
  return `<!-- gen:${name} sha256=${hash(content)} -->\n${content}\n<!-- /gen:${name} -->`;
}

function replaceRegion(html: string, name: string, content: string): string {
  const re = new RegExp(`<!-- gen:${name} sha256=([^\\s]+) -->\\s*([\\s\\S]*?)\\s*<!-- /gen:${name} -->`);
  const m = html.match(re);
  if (!m) throw new Error(`master template is missing generated region "${name}" — run compose with --rebuild to upgrade the shell`);
  if (m[1] !== 'empty' && m[1] !== hash(m[2])) {
    throw new Error(`generated region "${name}" was edited by hand; fix trip.db/prose blocks, then compose again`);
  }
  return html.replace(re, region(name, content));
}

function readBlocks(dir: string, slug: string): Record<string, string> {
  const blockDir = join(dir, 'blocks', slug);
  if (!existsSync(blockDir)) return {};
  const blocks: Record<string, string> = {};
  for (const f of readdirSync(blockDir)) {
    if (!f.endsWith('.html')) continue;
    blocks[f.slice(0, -5)] = readFileSync(join(blockDir, f), 'utf8').trim();
  }
  return blocks;
}

function applyBlocks(html: string, blocks: Record<string, string>): string {
  let out = html;
  for (const [name, content] of Object.entries(blocks)) {
    const re = new RegExp(`<!-- prose:${name} -->[\\s\\S]*?(?=<\\/section>|<!-- prose:)`);
    if (re.test(out)) out = out.replace(re, `<!-- prose:${name} -->\n${content}\n`);
  }
  return out;
}

// ---------- small formatting helpers ----------

function modeGlyph(mode: string | null | undefined): string {
  if (!mode) return '·';
  for (const [re, glyph] of MODE_GLYPHS) if (re.test(mode)) return glyph;
  return esc(mode);
}

function minutesLabel(min: number | null | undefined): string {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? String(m).padStart(2, '0') : ''}` : `${m}m`;
}

/** Duration of a leg: explicit minutes if the row has them, else derived from
 *  parseable depart/arrive timestamps ("2026-09-04 08:00" style). */
function legMinutes(leg: Row): number | null {
  if (leg.travel_minutes != null) return leg.travel_minutes;
  const from = Date.parse(String(leg.depart ?? '').replace(' ', 'T'));
  const to = Date.parse(String(leg.arrive ?? '').replace(' ', 'T'));
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  return Math.round((to - from) / 60000);
}

function money(amount: number | null | undefined, currency: string | null | undefined, base: string): string {
  return amount == null ? '—' : formatMinor(amount, currency ?? base);
}

function statusBadge(status: string | null | undefined): string {
  const s = status ?? 'candidate';
  return `<span class="badge status-${esc(s)}">${esc(s)}</span>`;
}

function tagChip(anchor: string): string {
  return `<a class="tag" href="#${anchor}">#${anchor}</a>`;
}

function linkPlace(p?: Row | null): string {
  if (!p) return '—';
  const name = p.place_name ?? p.name;
  const query = p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : String(name ?? '');
  const researchUrl = p.map_url ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return name ? `<a href="${esc(researchUrl)}" class="ext" aria-label="Research ${esc(name)}">${esc(name)}</a>` : '—';
}

function directions(from?: Row | null, to?: Row | null): string {
  if (!from || !to) return '';
  const pt = (p: Row) => (p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : String(p.name));
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(pt(from))}&destination=${encodeURIComponent(pt(to))}`;
}

function directionsForPoints(points: Row[]): string {
  if (points.length < 2) return '';
  const point = (p: Row) => (p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : String(p.name ?? ''));
  const origin = point(points[0]);
  const destination = point(points[points.length - 1]);
  const waypoints = points.slice(1, -1).map(point).filter(Boolean);
  const params = [
    `api=1`,
    `origin=${encodeURIComponent(origin)}`,
    `destination=${encodeURIComponent(destination)}`,
    waypoints.length ? `waypoints=${encodeURIComponent(waypoints.join('|'))}` : '',
    'travelmode=driving',
  ].filter(Boolean).join('&');
  return `https://www.google.com/maps/dir/?${params}`;
}

function weekday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

function shortDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function hint(text: string): string {
  return `<p class="hint">${esc(text)}</p>`;
}

function table(rows: Row[], cols: [string, (r: Row) => string][], empty: string): string {
  if (!rows.length) return hint(empty);
  return `<table><thead><tr>${cols.map(([h]) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map(([, f]) => `<td>${f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ---------- state ----------

function readState(db: Database, hosted: boolean, warnings: string[]) {
  const trip = one(db, 'SELECT name, base_currency, start_date, end_date, stage, total_budget FROM trip WHERE id = 1') ?? {};
  const base = trip.base_currency ?? 'INR';
  const members = all(db, 'SELECT id, display_name FROM members WHERE left_at IS NULL ORDER BY id');
  const places = new Map(all(db, 'SELECT * FROM places').map((p) => [p.id, p]));
  const destinations = all(db, `SELECT d.*, p.name AS place_name, p.lat, p.lng, p.map_url FROM destinations d LEFT JOIN places p ON p.id = d.place_id WHERE d.status != 'rejected' ORDER BY d.order_index, d.id`);
  const hops = all(db, "SELECT * FROM transport_hops WHERE status != 'rejected' ORDER BY id");
  const legs = all(db, "SELECT l.*, m.display_name AS member_name, fp.name AS from_name, tp.name AS to_name FROM legs l LEFT JOIN members m ON m.id=l.member_id LEFT JOIN places fp ON fp.id=l.from_place_id LEFT JOIN places tp ON tp.id=l.to_place_id WHERE l.status != 'rejected' ORDER BY l.direction, l.member_id, l.id");
  const stays = all(db, "SELECT s.*, p.name AS place_name, p.lat, p.lng, p.map_url, p.rating, p.review_count, d.order_index FROM stays s LEFT JOIN places p ON p.id=s.place_id LEFT JOIN destinations d ON d.id=s.destination_id WHERE s.status != 'rejected' ORDER BY d.order_index, s.check_in, s.id");
  const days = all(db, 'SELECT d.*, p.name AS base_name FROM days d LEFT JOIN places p ON p.id=d.base_place_id ORDER BY d.date, d.id');
  const items = all(db, "SELECT i.*, p.name AS place_name, p.map_url FROM itinerary_items i LEFT JOIN places p ON p.id=i.place_id WHERE i.status != 'rejected' ORDER BY i.day_id, i.id");
  const meals = all(db, "SELECT m.*, p.name AS place_name, p.map_url FROM meals m LEFT JOIN places p ON p.id=m.place_id WHERE m.status != 'rejected' ORDER BY m.day_id, m.id");
  const events = all(db, "SELECT e.*, p.name AS place_name, p.map_url FROM events e LEFT JOIN places p ON p.id=e.place_id WHERE e.status != 'rejected' ORDER BY e.date, e.id");
  const decisions = all(db, 'SELECT * FROM decisions ORDER BY status, id');
  const scratchpad = all(db, "SELECT * FROM scratchpad WHERE status = 'open' ORDER BY id DESC");
  const journal = all(db, 'SELECT * FROM journal ORDER BY id DESC LIMIT 10');

  // Cost rollup by category and currency. Minor units throughout; stays multiply by nights.
  const byCurrency: Record<string, Record<string, number>> = {};
  const addCost = (cat: string, amount: number | null | undefined, currency: string | null | undefined) => {
    if (amount == null) return;
    const cur = currency ?? base;
    byCurrency[cur] ??= {};
    byCurrency[cur][cat] = (byCurrency[cur][cat] ?? 0) + amount;
  };
  for (const l of legs) addCost('transport', l.cost, l.currency);
  for (const h of hops) addCost('transport', h.cost, h.currency);
  for (const s of stays) addCost('stays', s.cost_per_night != null ? s.cost_per_night * (s.nights ?? 0) : null, s.currency);
  for (const i of items) addCost('activities', i.cost, i.currency);
  for (const m of meals) addCost('food', m.cost, m.currency);

  // Booking ledger: everything with a booking obligation or deadline, across tables.
  const dayDates = new Map(days.map((d) => [d.id, d.date]));
  const bookings: Row[] = [
    ...stays.map((s) => ({ what: `Stay — ${s.place_name ?? 'TBD'}`, when: s.check_in, deadline: null, url: s.booking_url, status: s.status })),
    ...legs.map((l) => ({ what: `${l.direction === 'outbound' ? 'Return' : 'Travel'} — ${l.member_name ?? 'Shared'} · ${l.from_name ?? '?'} → ${l.to_name ?? '?'}`, when: l.depart, deadline: null, url: l.booking_url, status: l.status })),
    ...items.filter((i) => i.booking_required || i.ticket_deadline).map((i) => ({ what: `Ticket — ${i.title}`, when: dayDates.get(i.day_id) ?? null, deadline: i.ticket_deadline, url: i.booking_url ?? i.info_url, status: i.status })),
    ...events.filter((e) => e.booking_required || e.ticket_deadline).map((e) => ({ what: `Event — ${e.title}`, when: e.date, deadline: e.ticket_deadline, url: e.source_url, status: e.status })),
  ];

  return { trip, base, members, places, destinations, hops, legs, stays, days, items, meals, events, decisions, scratchpad, journal, byCurrency, bookings, hosted, warnings };
}

type State = ReturnType<typeof readState>;

// ---------- generated sections ----------

function headerMeta(state: State): string {
  const { trip, members, destinations } = state;
  const nights = destinations.reduce((n, d) => n + Number(d.nights ?? 0), 0);
  const chips = [
    trip.start_date ? `<span class="chip">📅 ${esc(shortDate(trip.start_date))}${trip.end_date ? ` → ${esc(shortDate(trip.end_date))}` : ''}</span>` : '',
    `<span class="chip">👥 ${esc(members.map((m) => m.display_name).join(', ') || 'travellers TBD')}</span>`,
    nights ? `<span class="chip">🌙 ${nights} nights planned</span>` : '',
    destinations.length ? `<span class="chip">📍 ${destinations.length} stops</span>` : '',
  ].filter(Boolean).join(' ');
  return `<div class="meta-chips"><span class="stage-badge">${esc(trip.stage ?? 'planning')}</span> ${chips}</div>`;
}

function navRegion(state: State, blocks: Record<string, string>): string {
  const links: [string, string, boolean][] = [
    ['summary', '🧭 Summary', true],
    ['map', '🗺️ Map', state.destinations.length > 0],
    ['calendar', '📅 Calendar', state.days.length > 0],
    ['overview', 'Overview', Boolean(blocks.intro)],
    ['route-options', 'Options', Boolean(blocks.options)],
    ['travel', '🚆 Travel', true],
    ['route', 'Route', true],
    ['stays', '🏨 Stays', true],
    ['budget', '💷 Budget', Object.keys(state.byCurrency).length > 0],
    ['days', 'Day-by-day', true],
    ['sights-overview', '🏰 Sights', Boolean(blocks.sights)],
    ['food', '🥗 Food', Boolean(blocks.food)],
    ['weather', '🌦️ Weather', Boolean(blocks.weather)],
    ['packing', '🎒 Packing', Boolean(blocks.packing)],
  ];
  const ops: [string, string][] = [['decisions', '⚖️ Decisions'], ['bookings', '🎟️ Bookings'], ['changelog', 'History']];
  return `<nav class="doc-nav" aria-label="Sections">${links.filter(([, , show]) => show).map(([a, label]) => `<a href="#${a}">${label}</a>`).join('')}${ops.map(([a, label]) => `<a href="#${a}" class="ops-link">${label}</a>`).join('')}</nav>`;
}

function stayForDate(state: State, date: string): Row | null {
  return state.stays.find((s) => s.check_in && s.check_out && String(s.check_in) <= date && date < String(s.check_out)) ?? null;
}

function appendRoutePoint(points: Row[], point: Row | null | undefined): void {
  if (!point) return;
  const previous = points[points.length - 1];
  if (!previous || previous.id !== point.id) points.push(point);
}

function dayRoute(state: State, day: Row, dayItems: Row[], dayMeals: Row[], dayEvents: Row[]): { points: Row[]; url: string; knownMinutes: number } {
  const stay = stayForDate(state, String(day.date));
  const overnight = (stay && state.places.get(stay.place_id)) || state.places.get(day.base_place_id);
  const points: Row[] = [];
  appendRoutePoint(points, overnight);
  for (const item of dayItems) {
    appendRoutePoint(points, state.places.get(item.travel_from_place_id));
    appendRoutePoint(points, state.places.get(item.place_id));
  }
  for (const meal of dayMeals) appendRoutePoint(points, state.places.get(meal.place_id));
  for (const event of dayEvents) appendRoutePoint(points, state.places.get(event.place_id));
  appendRoutePoint(points, overnight);
  return {
    points,
    url: directionsForPoints(points),
    knownMinutes: dayItems.reduce((n, item) => n + Number(item.travel_minutes ?? 0), 0),
  };
}

function quickSummary(state: State, blocks: Record<string, string>): string {
  const destinationNames = state.destinations.map((d) => linkPlace(d)).join(' → ') || 'Route not set';
  const stayNames = state.stays.map((s) => linkPlace(s)).filter(Boolean).join(' · ') || 'Stays not recorded';
  const dayLinks = state.days.map((d, i) => `<a href="#day-${i + 1}">#day-${i + 1} · ${esc(d.base_name ?? 'TBD')}</a>`).join(' · ') || 'Days not planned';
  const researchLinks = [
    blocks.sights ? '<a href="#sights-overview">#sights-overview</a>' : '',
    blocks.food ? '<a href="#food">#food</a>' : '',
    blocks.weather ? '<a href="#weather">#weather</a>' : '',
    blocks.packing ? '<a href="#packing">#packing</a>' : '',
  ].filter(Boolean).join(' · ') || 'Research sections not added';
  const card = (anchor: string, label: string, body: string) => `<div class="summary-card"><a href="#${anchor}"><b>${label}</b></a><div>${body}</div></div>`;
  return `<section id="summary" class="panel quick-summary">
<h2>🧭 Quick summary ${tagChip('summary')}</h2>
<div class="summary-grid">
${card('route', 'Route', destinationNames)}
${card('stays', 'Stays', stayNames)}
${card('travel', 'Travel', `${state.legs.length} travel leg${state.legs.length === 1 ? '' : 's'} · ${state.hops.length} inter-stop segment${state.hops.length === 1 ? '' : 's'}`)}
${card('days', 'Day-by-day', dayLinks)}
${card('budget', 'Budget', Object.keys(state.byCurrency).length ? 'See the planned cost roll-up' : 'No costs recorded yet')}
${card('sights-overview', 'Research', researchLinks)}
</div>
</section>`;
}

/**
 * The schematic route strip — the planning-decision view of the trip. Overnight
 * stops are solid nodes sized by nights (count inside), home endpoints are squares,
 * segment edges carry mode glyph + duration. Pure inline SVG: PDF-safe, no network.
 */
function routeStrip(state: State): string {
  const { destinations, hops, legs, places } = state;
  if (!destinations.length) return hint('No route stops yet — the strip appears as destinations are added to the plan.');

  interface Node { label: string; sub: string; kind: 'home' | 'stop'; nights: number }
  interface EdgeInfo { label: string; dashed: boolean }
  const nodes: Node[] = [];
  const edges: EdgeInfo[] = [];

  const inbound = legs.find((l) => l.direction === 'inbound');
  const outbound = legs.find((l) => l.direction === 'outbound');
  if (inbound?.from_name) {
    nodes.push({ label: inbound.from_name, sub: 'home', kind: 'home', nights: 0 });
    edges.push({ label: `${modeGlyph(inbound.mode)} ${minutesLabel(legMinutes(inbound)) || esc(inbound.mode ?? '')}`.trim(), dashed: /fly|flight|train|rail/i.test(inbound.mode ?? '') });
  }
  destinations.forEach((d, i) => {
    nodes.push({ label: d.place_name ?? 'TBD', sub: `${d.nights} night${d.nights === 1 ? '' : 's'}`, kind: 'stop', nights: Number(d.nights ?? 0) });
    const next = destinations[i + 1];
    if (next) {
      const hop = hops.find((h) => h.from_place_id === d.place_id && h.to_place_id === next.place_id);
      edges.push({
        label: `${modeGlyph(hop?.mode ?? 'drive')} ${minutesLabel(hop?.travel_minutes)}${hop?.buffer ? ` +${minutesLabel(hop.buffer)} stops` : ''}`.trim(),
        dashed: /fly|flight/i.test(hop?.mode ?? ''),
      });
    }
  });
  if (outbound?.to_name) {
    const lastDest = destinations[destinations.length - 1];
    const viaHop = hops.find((h) => h.from_place_id === lastDest?.place_id && !destinations.some((d) => d.place_id === h.to_place_id));
    const parts = [viaHop ? `${modeGlyph(viaHop.mode)} ${minutesLabel(viaHop.travel_minutes)}` : '', `${modeGlyph(outbound.mode)} ${minutesLabel(legMinutes(outbound)) || 'home'}`].filter(Boolean);
    nodes.push({ label: outbound.to_name, sub: 'home', kind: 'home', nights: 0 });
    edges.push({ label: parts.join(' → '), dashed: /fly|flight/i.test(outbound.mode ?? '') });
  }

  const stepW = 148;
  const width = Math.max(560, 90 + stepW * (nodes.length - 1) + 90);
  const y = 64;
  const x0 = 90;
  const pos = nodes.map((_, i) => x0 + (nodes.length === 1 ? 0 : ((width - 180) / (nodes.length - 1)) * i));

  const edgeSvg = edges.map((e, i) => {
    const x1 = pos[i];
    const x2 = pos[i + 1];
    return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#1f6a4c" stroke-width="3.5"${e.dashed ? ' stroke-dasharray="7 5"' : ''} stroke-linecap="round" opacity="0.55"/>
<text x="${(x1 + x2) / 2}" y="${y - 22}" text-anchor="middle" font-size="12" font-weight="600" fill="#41564b">${esc(e.label)}</text>`;
  }).join('\n');

  const nodeSvg = nodes.map((n, i) => {
    const x = pos[i];
    if (n.kind === 'home') {
      return `<rect x="${x - 9}" y="${y - 9}" width="18" height="18" rx="4" fill="#8b978f"/>
<text x="${x}" y="${y + 34}" text-anchor="middle" font-size="13" font-weight="700" fill="#22302a">${esc(n.label)}</text>
<text x="${x}" y="${y + 50}" text-anchor="middle" font-size="11" fill="#68766e">${esc(n.sub)}</text>`;
    }
    const r = Math.max(13, Math.min(21, 12 + n.nights * 2));
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#1f6a4c"/>
<circle cx="${x}" cy="${y}" r="${r - 3.5}" fill="none" stroke="#ffffff" stroke-opacity="0.35"/>
<text x="${x}" y="${y + 4.5}" text-anchor="middle" font-size="13" font-weight="800" fill="#fff">${n.nights || ''}</text>
<text x="${x}" y="${y + r + 21}" text-anchor="middle" font-size="13" font-weight="700" fill="#22302a">${esc(n.label)}</text>
<text x="${x}" y="${y + r + 37}" text-anchor="middle" font-size="11" fill="#68766e">${esc(n.sub)}</text>`;
  }).join('\n');

  return `<div class="strip-wrap"><svg class="route-strip" viewBox="0 0 ${width} 138" role="img" aria-label="Trip route: stops, nights, and travel times" xmlns="http://www.w3.org/2000/svg">
${edgeSvg}
${nodeSvg}
</svg></div>
<p class="muted small">Circles are overnight stops — the number inside is nights there. Squares are home. Edge labels are travel mode and time${hops.some((h) => h.buffer) ? ' (+ sightseeing-stop buffer)' : ''}; dashed means rail/air.</p>`;
}

/** The geographic Leaflet map — hosted output only (needs network for tiles). */
function geoMap(state: State): string {
  const { destinations, legs, places, hosted, warnings, hops } = state;
  const stops = destinations.filter((d) => d.lat != null && d.lng != null);
  const missing = destinations.length - stops.length;
  if (missing > 0) warnings.push(`${missing} route stop(s) missing coordinates; omitted from geographic map (set with: place add --lat --lng, or a Google Maps --map-url)`);
  if (!hosted || !stops.length) return '';

  const endpoints: Row[] = [];
  for (const l of legs) {
    for (const pid of [l.from_place_id, l.to_place_id]) {
      const p = places.get(pid);
      if (p && p.lat != null && p.lng != null && !stops.some((s) => s.place_id === pid) && !endpoints.some((e) => e.id === pid)) endpoints.push(p);
    }
  }
  const payload = {
    stops: stops.map((d) => ({ name: d.place_name, lat: d.lat, lng: d.lng, nights: d.nights, status: d.status })),
    marks: endpoints.map((p) => ({ name: p.name, lat: p.lat, lng: p.lng })),
  };
  return `<div id="geo-map" class="geo-map">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="${LEAFLET_CSS_SRI}" crossorigin="">
<div id="geo-map-canvas" data-geo='${esc(JSON.stringify(payload))}'></div>
<p class="muted small">Live map (hosted view only — the PDF keeps the route strip above). Tap a marker for nights and status.</p>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="${LEAFLET_JS_SRI}" crossorigin=""></script>
<script>(()=>{const el=document.getElementById('geo-map-canvas');if(!el||typeof L==='undefined')return;const d=JSON.parse(el.dataset.geo);const map=L.map(el,{scrollWheelZoom:false});L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);const pts=[];for(const s of d.stops){pts.push([s.lat,s.lng]);L.circleMarker([s.lat,s.lng],{radius:8+Math.min(6,s.nights*1.5),color:'#12382b',weight:2,fillColor:'#1f6a4c',fillOpacity:.85}).addTo(map).bindPopup('<b>'+s.name+'</b><br>'+s.nights+' night'+(s.nights===1?'':'s')+' · '+s.status)}for(const m of d.marks){L.circleMarker([m.lat,m.lng],{radius:5,color:'#68766e',weight:2,fillColor:'#8b978f',fillOpacity:.8}).addTo(map).bindPopup('<b>'+m.name+'</b>')}if(pts.length>1)L.polyline(pts,{color:'#1f6a4c',weight:3,opacity:.7}).addTo(map);const allPts=pts.concat(d.marks.map(m=>[m.lat,m.lng]));map.fitBounds(L.latLngBounds(allPts).pad(0.08));})();</script>
</div>`;
}

/** Calendar ribbon — the whole trip as one row of day blocks, coloured per base. */
function calendarRibbon(state: State): string {
  const { days, items } = state;
  if (!days.length) return '';
  const baseColors = new Map<unknown, string>();
  for (const d of days) {
    if (!baseColors.has(d.base_place_id)) baseColors.set(d.base_place_id, RIBBON_PALETTE[baseColors.size % RIBBON_PALETTE.length]);
  }
  const deadlineDays = new Set(items.filter((i) => i.ticket_deadline).map((i) => i.day_id));
  const cells = days.map((d, i) => {
    const color = baseColors.get(d.base_place_id) ?? '#9aa79f';
    return `<a href="#day-${i + 1}" style="--rb:${color}"><span class="rb-day">Day ${i + 1} · ${esc(weekday(d.date))} ${esc(shortDate(d.date))}</span><span class="rb-place">${esc(d.base_name ?? 'TBD')}</span><span class="rb-theme">${esc(d.theme ?? '')}${deadlineDays.has(d.id) ? ' <span class="rb-deadline">• ticket</span>' : ''}</span></a>`;
  }).join('');
  return `<section id="calendar" class="panel"><h2>📅 Calendar ${tagChip('calendar')}</h2><div class="ribbon">${cells}</div></section>`;
}

function heroRegion(state: State): string {
  return `<section id="map" class="panel"><h2>🗺️ Route map ${tagChip('map')}</h2>${routeStrip(state)}${geoMap(state)}</section>
${calendarRibbon(state)}`;
}

function budgetSection(state: State): string {
  const { byCurrency, base, trip } = state;
  const currencies = Object.keys(byCurrency);
  if (!currencies.length) return `<section id="budget" class="panel"><h2>💷 Budget ${tagChip('budget')}</h2>${hint('Costs appear here as legs, stays, activities and meals gain prices.')}</section>`;
  const catLabel: Record<string, string> = { transport: '🚆 Transport', stays: '🏨 Stays', activities: '🎟️ Activities', food: '🥗 Food' };
  const chips = currencies.map((cur) => {
    const cats = byCurrency[cur];
    const total = Object.values(cats).reduce((a, b) => a + b, 0);
    const detail = Object.entries(cats).map(([c, v]) => `${catLabel[c] ?? c} ${money(v, cur, base)}`).join(' · ');
    return `<div class="chip"><b>${money(total, cur, base)}</b><span class="muted small"> — ${detail}</span></div>`;
  }).join('');
  let bar = '';
  if (trip.total_budget != null && byCurrency[base]) {
    const total = Object.values(byCurrency[base]).reduce((a, b) => a + b, 0);
    const pct = Math.min(100, Math.round((total / trip.total_budget) * 100));
    bar = `<div class="bar"><span style="width:${pct}%"></span></div><p class="muted small">${money(total, base, base)} of ${money(trip.total_budget, base, base)} budget (${pct}%)</p>`;
  }
  return `<section id="budget" class="panel"><h2>💷 Budget ${tagChip('budget')}</h2><div class="budget-chips">${chips}</div>${bar}<p class="muted small">Planned costs from the current plan — not the live expense ledger (that lives in trip-finance).</p></section>`;
}

function daysSection(state: State): string {
  const { days, items, meals, events, base } = state;
  const daySections = days.map((d, i) => {
    const anchor = `day-${i + 1}`;
    const dayItems = items.filter((it) => it.day_id === d.id).sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
    const dayMeals = meals.filter((m) => m.day_id === d.id);
    const dayEvents = events.filter((e) => e.date === d.date);
    const stay = stayForDate(state, String(d.date));
    const overnight = (stay && state.places.get(stay.place_id)) || state.places.get(d.base_place_id);
    const route = dayRoute(state, d, dayItems, dayMeals, dayEvents);
    const kind = /transit|drive|travel|→|->/i.test(d.theme ?? '') ? 'transit' : /city|edinburgh|arrive/i.test(d.theme ?? '') ? 'city' : 'explore';
    const rows = dayItems.map((it) => {
      const bits = [
        `<span class="slot-chip">${esc(it.slot)}</span>`,
        it.start ? `<span class="muted small">${esc([it.start, it.end].filter(Boolean).join('–'))}</span>` : '',
        `<b>${esc(it.title)}</b>`,
        it.place_name ? `<span class="muted small">@ ${linkPlace(it)}</span>` : '',
        it.travel_minutes != null ? `<span class="travel-chip">${modeGlyph(it.travel_mode)} ${minutesLabel(it.travel_minutes)}</span>` : '',
        it.cost != null && it.cost > 0 ? `<span class="price">${money(it.cost, it.currency, base)}</span>` : '',
        it.booking_required ? `<span class="badge badge-red">book${it.ticket_deadline ? ` by ${esc(shortDate(it.ticket_deadline))}` : ''}</span>` : '',
        it.status !== 'committed' ? statusBadge(it.status) : '',
        it.info_url ? `<a href="${esc(it.info_url)}" class="ext small">research</a>` : '',
        it.notes ? `<span class="muted small">${esc(it.notes)}</span>` : '',
      ].filter(Boolean).join(' ');
      return `<li>${bits}</li>`;
    }).join('');
    const mealText = dayMeals.map((m) => `${esc(m.slot)}: ${linkPlace(m)}${m.veg_ok ? ' <span class="badge badge-green">veg ok</span>' : ''}${m.cost ? ` <span class="price">${money(m.cost, m.currency, base)}</span>` : ''}`).join(' · ');
    const eventText = dayEvents.map((e) => `${e.kind === 'avoid' ? '⚠️ avoid: ' : ''}${esc(e.title)}${e.place_id ? ` @ ${linkPlace(state.places.get(e.place_id))}` : ''}${e.source_url ? ` <a href="${esc(e.source_url)}" class="ext small">research</a>` : ''}`).join(' · ');
    const stayText = overnight
      ? `${stay ? linkPlace(stay) : linkPlace(overnight)} ${tagChip(`stays-${slugText(overnight.name)}`)}${stay ? ` <span class="muted small">${shortDate(stay.check_in)} → ${shortDate(stay.check_out)} · ${stay.nights ?? '?'} night${stay.nights === 1 ? '' : 's'}</span>` : ' <span class="badge badge-yellow">stay not recorded</span>'}`
      : '<span class="badge badge-yellow">stay not recorded</span>';
    const pointLinks = route.points.map((p) => linkPlace(p)).filter(Boolean).filter((p, index, all) => all.indexOf(p) === index).join(' · ');
    const routeLink = route.url ? `<a href="${esc(route.url)}" class="ext">open day route in Google Maps (distance + travel time)</a>${route.knownMinutes ? ` <span class="muted small">${minutesLabel(route.knownMinutes)} known travel time</span>` : ''}` : 'Add at least two mapped points for a day route.';
    return `<section id="${anchor}" class="day-card ${kind}">
<div class="day-label">Day ${i + 1} · ${esc(weekday(d.date))} ${esc(shortDate(d.date))}${d.base_name ? ` · 📍 ${esc(d.base_name)}` : ''} ${tagChip(anchor)}</div>
<h3>${esc(d.theme ?? d.base_name ?? 'Plan')}</h3>
<p class="stay-line">🌙 <b>Staying tonight:</b> ${stayText}</p>
<p class="route-line">🗺️ <b>Day route:</b> ${routeLink}</p>
${pointLinks ? `<p class="point-line">📌 <b>Points to research:</b> ${pointLinks}</p>` : ''}
${rows ? `<ul class="slots">${rows}</ul>` : hint('No itinerary items yet for this day.')}
${mealText ? `<p class="meal-line">🍽️ ${mealText}</p>` : ''}
${eventText ? `<p class="event-line">🎫 ${eventText}</p>` : ''}
</section>`;
  }).join('\n');
  return `<section id="days" class="panel"><h2>🌄 Day-by-day ${tagChip('days')}</h2>${daySections || hint('No days planned yet — they appear here as the itinerary takes shape.')}</section>`;
}

function planRegion(state: State): string {
  const { legs, destinations, stays, places, base } = state;
  const routeRows = destinations.map((d, i) => ({ ...d, next: destinations[i + 1] }));
  const travel = table(legs, [
    ['Traveller', (r) => esc(r.member_name ?? 'Shared')],
    ['Direction', (r) => esc(r.direction ?? '—')],
    ['Route', (r) => `${esc(r.from_name ?? 'TBD')} → ${esc(r.to_name ?? 'TBD')}`],
    ['Mode', (r) => `${modeGlyph(r.mode)} ${esc(r.mode ?? '')}${r.carrier ? ` · ${esc(r.carrier)}` : ''}`],
    ['Departs', (r) => esc(r.depart ?? '—')],
    ['Cost pp', (r) => `<span class="price">${money(r.cost, r.currency, base)}</span>`],
    ['Status', (r) => `${statusBadge(r.status)}${r.booking_url ? ` <a href="${esc(r.booking_url)}" class="ext small">book</a>` : ''}`],
  ], 'No travel legs yet — inbound and outbound journeys per traveller appear here.');
  const route = table(routeRows, [
    ['Stop', (r) => `${linkPlace(places.get(r.place_id))} ${tagChip(`stays-${slugText(r.place_name)}`)}`],
    ['Nights', (r) => esc(r.nights)],
    ['Why', (r) => esc(r.rationale ?? '—')],
    ['Next segment', (r) => (r.next ? `<a href="${esc(directions(places.get(r.place_id), places.get(r.next.place_id)))}" class="ext">open leg in Google Maps</a>` : '—')],
    ['Status', (r) => statusBadge(r.status)],
  ], 'No route stops yet — destinations appear here as the route firms up.');
  const staysTable = table(stays, [
    ['Stay', (r) => `<span id="stays-${slugText(r.place_name)}"></span>${linkPlace(r)}${r.rating ? `<br><span class="muted small">★ ${esc(r.rating)}${r.review_count ? ` (${esc(r.review_count)} reviews)` : ''}</span>` : ''}`],
    ['Dates', (r) => `${esc(shortDate(r.check_in ?? ''))} → ${esc(shortDate(r.check_out ?? ''))}`],
    ['Nights', (r) => esc(r.nights ?? '')],
    ['Per night', (r) => `<span class="price">${money(r.cost_per_night, r.currency, base)}</span>`],
    ['Veg breakfast', (r) => (r.breakfast_included ? '<span class="badge badge-green">included</span>' : '<span class="badge badge-yellow">confirm</span>')],
    ['Status', (r) => `${statusBadge(r.status)}${r.booking_url ? ` <a href="${esc(r.booking_url)}" class="ext small">book</a>` : ''}`],
  ], 'No stays yet — candidate hotels appear here per stop.');
  return `<section id="travel" class="panel"><h2>🚆 Getting there &amp; back ${tagChip('travel')}</h2>${travel}</section>
<section id="route" class="panel"><h2>📍 Route &amp; segments ${tagChip('route')}</h2>${route}</section>
<section id="stays" class="panel"><h2>🏨 Stays ${tagChip('stays')}</h2>${staysTable}</section>
${budgetSection(state)}
${daysSection(state)}`;
}

function opsRegion(state: State): string {
  const now = new Date().toISOString();
  const open = state.decisions.filter((d) => d.status === 'open');
  const closed = state.decisions.filter((d) => d.status !== 'open');
  const overdueBookings = state.bookings.filter((b) => b.deadline && b.deadline < now.slice(0, 10));
  const pulse = [
    `<span class="badge status-committed">${closed.length} decision${closed.length === 1 ? '' : 's'} settled</span>`,
    `<span class="badge status-shortlisted">${open.length} open</span>`,
    `<span class="badge ${overdueBookings.length ? 'status-overdue' : 'status-candidate'}">${overdueBookings.length} booking deadline${overdueBookings.length === 1 ? '' : 's'} passed</span>`,
  ].join(' ');
  const decisions = table(state.decisions, [
    ['Decision', (r) => `${esc(r.question)} ${tagChip(`decision-${r.id}`)}<span id="decision-${r.id}"></span>`],
    ['Status', (r) => `<span class="badge ${r.status === 'open' ? 'status-shortlisted' : 'status-committed'}">${esc(r.status)}</span>`],
    ['Commit by', (r) => esc(r.commit_by ? shortDate(String(r.commit_by).slice(0, 10)) : '—')],
    ['Outcome', (r) => esc(r.outcome ?? '—')],
  ], 'No decisions recorded yet.');
  const questions = table(state.scratchpad, [
    ['Topic', (r) => esc(r.topic ?? 'general')],
    ['Question / leaning', (r) => esc(r.note)],
  ], 'No open questions on the scratchpad.');
  const bookings = table(state.bookings, [
    ['What', (r) => `${esc(r.what)}${r.url ? ` <a href="${esc(r.url)}" class="ext small">link</a>` : ''}`],
    ['For date', (r) => esc(r.when ? shortDate(String(r.when).slice(0, 10)) : '—')],
    ['Book by', (r) => (r.deadline ? `<span class="${r.deadline < now.slice(0, 10) ? 'badge status-overdue' : 'price'}">${esc(shortDate(r.deadline))}</span>` : '—')],
    ['Status', (r) => statusBadge(r.status)],
  ], 'Booking obligations appear here as stays, legs and ticketed items enter the plan.');
  const journal = table(state.journal, [
    ['When', (r) => esc(String(r.at ?? '').slice(0, 16).replace('T', ' '))],
    ['Action', (r) => esc(r.action)],
    ['Entity', (r) => esc(r.entity)],
  ], 'No journal entries yet.');
  return `<section class="panel"><h2>📊 Operations pulse</h2><div class="pulse">${pulse}</div></section>
<section id="decisions" class="panel"><h2>⚖️ Decisions ${tagChip('decisions')}</h2>${decisions}</section>
<section id="open-questions" class="panel"><h2>❓ Open questions ${tagChip('open-questions')}</h2>${questions}</section>
<section id="bookings" class="panel"><h2>🎟️ Booking ledger ${tagChip('bookings')}</h2>${bookings}</section>
<section id="changelog" class="panel"><h2>🕘 Plan changelog ${tagChip('changelog')}</h2>${journal}<p class="muted small">Document versions live in the revision history at the end of this page.</p></section>`;
}

// ---------- entry point ----------

export function composeMaster(opts: ComposeOptions): ComposeResult {
  const file = opts.slug.endsWith('.html') ? opts.slug : `${opts.slug}.html`;
  const path = join(opts.dir, file);
  mkdirSync(join(opts.dir, 'blocks', opts.slug), { recursive: true });

  const db = new Database(opts.dbPath, { readonly: true });
  const warnings: string[] = [];
  const state = readState(db, Boolean(opts.hosted), warnings);
  db.close();
  const title = state.trip.name ? `${state.trip.name} — Master Document` : opts.slug;

  let html: string;
  if (!existsSync(path)) {
    html = scaffold({ title, date: opts.date, type: 'master', summary: 'Created master document' });
  } else if (opts.rebuild) {
    // Template upgrade: fresh shell, carry the version + revision trail across.
    const prev = summarize(readFileSync(path, 'utf8'));
    html = restoreHistory(scaffold({ title, date: opts.date, type: 'master', summary: 'Created master document' }), prev);
  } else {
    html = readFileSync(path, 'utf8');
  }

  const blocks = readBlocks(opts.dir, opts.slug);
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = html.replace(/<h1>[\s\S]*?<\/h1>/i, `<h1>${esc(title)}</h1>`);
  if (!/<!-- gen:summary sha256=/.test(html)) {
    html = html.replace(/(\s*<!-- gen:hero sha256=[^>]+ -->)/, `\n    <!-- gen:summary sha256=empty -->\n    <!-- /gen:summary -->$1`);
  }
  html = replaceRegion(html, 'header', headerMeta(state));
  html = replaceRegion(html, 'nav', navRegion(state, blocks));
  html = replaceRegion(html, 'summary', quickSummary(state, blocks));
  html = replaceRegion(html, 'hero', heroRegion(state));
  html = replaceRegion(html, 'plan', planRegion(state));
  html = replaceRegion(html, 'ops', opsRegion(state));
  html = normalizeSectionMarkers(applyBlocks(html, blocks));
  writeFileSync(path, html);

  const version = summarize(html).version;
  writeFileSync(join(opts.dir, 'version.json'), JSON.stringify({ slug: opts.slug, version, summary: summarize(html).revisions[0]?.summary ?? '', updated_at: opts.date }, null, 2));
  return { file, path, version, warnings };
}

/** Compose the keepsake recap through the same hash-guarded generated-region mechanism as master. */
export function composeRecap(opts: ComposeOptions): ComposeResult {
  const file = opts.slug.endsWith('.html') ? opts.slug : `${opts.slug}.html`; const path = join(opts.dir, file);
  mkdirSync(join(opts.dir, 'blocks', opts.slug), { recursive: true });
  const db = new Database(opts.dbPath, { readonly: true }); const warnings: string[] = []; const state = readState(db, false, warnings);
  const title = state.trip.name ? `${state.trip.name} — The Recap` : opts.slug;
  const query = <T extends Row>(sql: string, bind: Row = {}) => all<T>(db, sql, bind);
  const committedItems = query('SELECT i.*,d.date FROM itinerary_items i JOIN days d ON d.id=i.day_id WHERE i.status=\'committed\'');
  const diaries = query('SELECT d.*,m.display_name FROM diary_entries d LEFT JOIN members m ON m.id=d.member_id ORDER BY d.date,d.id');
  const photos = query("SELECT * FROM assets WHERE kind='photo' ORDER BY id");
  const expenses = query("SELECT description,amount,currency FROM expenses WHERE voided_at IS NULL ORDER BY amount DESC");
  const supers = query("SELECT question,outcome FROM decisions WHERE status='closed' AND question LIKE '[superlative]%'");
  const nights = state.destinations.filter((d) => d.status === 'committed').reduce((n, d) => n + Number(d.nights ?? 0), 0);
  const move = state.hops.filter((h) => h.status === 'committed').reduce((n, h) => n + Number(h.travel_minutes ?? 0), 0);
  const totals = new Map<string, number>(); for (const e of expenses) totals.set(e.currency, (totals.get(e.currency) ?? 0) + Number(e.amount));
  const stats = `<h2>Trip stats</h2><div class="stats"><div class="stat">${nights} nights away</div><div class="stat">${state.destinations.filter((d) => d.status === 'committed').length} destinations</div><div class="stat">${committedItems.length} moments planned</div><div class="stat">~${Math.round(move / 60)} h on the move</div><div class="stat">${photos.length} photos indexed</div><div class="stat">${diaries.length} diary entries</div></div><p>Shared spend: ${[...totals].map(([c, a]) => esc(formatMinor(a, c))).join(' · ') || 'not recorded'}</p><p>Biggest splurges: ${expenses.slice(0, 3).map((e) => `${esc(e.description)} (${esc(formatMinor(e.amount, e.currency))})`).join(' · ') || 'none recorded'}</p>`;
  const relative = (p: string) => p.replace(/^\/workspace\/agent\//, '');
  const days = state.days.filter((d) => d.status === 'committed').map((d) => { const items = committedItems.filter((i) => i.day_id === d.id); const entries = diaries.filter((x) => x.date === d.date); const imgs = photos.filter((p) => p.day_date === d.date).slice(0, 6); return `<article><h3>${esc(d.date)}${d.theme ? ` — ${esc(d.theme)}` : ''}</h3><p>${items.map((i) => esc(i.title)).join(' · ') || 'Unscripted day'}</p>${entries.map((e) => `<blockquote>${esc(e.entry)}${e.display_name ? ` — ${esc(e.display_name)}` : ''}</blockquote>`).join('')}<div class="photos">${imgs.map((p) => `<img src="${esc(relative(p.path))}" alt="${esc(p.label ?? 'trip photo')}">`).join('')}</div></article>`; }).join('') || '<p>No committed days yet — the story will appear as the trip is indexed.</p>';
  const superlatives = supers.length ? `<ul>${supers.map((s) => `<li>${esc(String(s.question).replace(/^\[superlative\]\s*/i, ''))}: ${esc(s.outcome ?? 'No result recorded')}</li>`).join('')}</ul>` : '<p>Run a few fun [superlative] polls to crown the trip’s best moments.</p>';
  db.close();
  let html = existsSync(path) ? readFileSync(path, 'utf8') : scaffold({ title, date: opts.date, type: 'recap', summary: 'Created recap document' });
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`).replace(/<h1>[\s\S]*?<\/h1>/i, `<h1>${esc(title)}</h1>`);
  html = replaceRegion(html, 'route', routeStrip(state)); html = replaceRegion(html, 'stats', stats); html = replaceRegion(html, 'days', days); html = replaceRegion(html, 'superlatives', superlatives);
  html = normalizeSectionMarkers(applyBlocks(html, readBlocks(opts.dir, opts.slug))); writeFileSync(path, html); const version = summarize(html).version;
  return { file, path, version, warnings };
}
