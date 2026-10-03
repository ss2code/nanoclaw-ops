import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeMaster, composeRecap } from '../scripts/compose';
import { bump, summarize } from '../scripts/docs';
import { openPlanningDb } from '../../trip-planning/scripts/db';
import { setTrip, addMember } from '../../trip-core/scripts/config';
import { addPlace } from '../../trip-planning/scripts/places';
import { addDay, addDestination, addHop, addItem, addStay, setStatus } from '../../trip-planning/scripts/items';
import { openDecision } from '../../trip-core/scripts/decisions';
import { addNote } from '../../trip-core/scripts/scratchpad';
import { closeDecision } from '../../trip-core/scripts/decisions';
import { addDiary } from '../../trip-core/scripts/diary';
import { indexAsset } from '../../trip-core/scripts/assets';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function seed() {
  dir = mkdtempSync(join(tmpdir(), 'trip-docs-compose-'));
  const dbPath = join(dir, 'trip.db');
  const db = openPlanningDb(dbPath);
  setTrip(db, { name: 'Scotland 2026', baseCurrency: 'GBP', startDate: '2026-09-01', endDate: '2026-09-08', totalBudget: 250000 }, null, '2026-07-08T00:00:00Z');
  const arjun = addMember(db, { displayName: 'Arjun', joinedAt: '2026-07-01' }, null, '2026-07-08T00:00:00Z');
  const edinburgh = addPlace(db, { name: 'Edinburgh', mapUrl: 'https://www.google.com/maps/@55.9533,-3.1883,12z' }, null, '2026-07-08T00:00:00Z');
  const portree = addPlace(db, { name: 'Portree', mapUrl: 'https://www.google.com/maps/place/Portree/@57.4125,-6.1960,14z' }, null, '2026-07-08T00:00:00Z');
  const storr = addPlace(db, { name: 'Old Man of Storr', mapUrl: 'https://www.google.com/maps/place/Old+Man+of+Storr/@57.5074,-6.1701,14z' }, null, '2026-07-08T00:00:00Z');
  const dest1 = addDestination(db, { placeId: edinburgh, orderIndex: 1, nights: 2 }, arjun, '2026-07-08T00:00:00Z');
  const dest2 = addDestination(db, { placeId: portree, orderIndex: 2, nights: 3 }, arjun, '2026-07-08T00:00:00Z');
  setStatus(db, 'destinations', dest1, 'committed', arjun, '2026-07-08T00:00:00Z');
  setStatus(db, 'destinations', dest2, 'committed', arjun, '2026-07-08T00:00:00Z');
  const hop = addHop(db, { fromPlaceId: edinburgh, toPlaceId: portree, mode: 'drive', travelMinutes: 300 }, arjun, '2026-07-08T00:00:00Z');
  setStatus(db, 'transport_hops', hop, 'committed', arjun, '2026-07-08T00:00:00Z');
  const stay = addStay(db, { destinationId: dest2, placeId: portree, tier: 'guesthouse', checkIn: '2026-09-03', checkOut: '2026-09-06', nights: 3, costPerNight: 15000, currency: 'GBP', breakfastIncluded: true }, arjun, '2026-07-08T00:00:00Z');
  setStatus(db, 'stays', stay, 'committed', arjun, '2026-07-08T00:00:00Z');
  const day = addDay(db, { date: '2026-09-04', basePlaceId: portree, theme: 'explore Skye' }, arjun, '2026-07-08T00:00:00Z');
  const item = addItem(db, { dayId: day, slot: 'morning', title: 'Old Man of Storr', placeId: storr, travelFromPlaceId: portree, travelMode: 'drive', travelMinutes: 45, cost: 0, currency: 'GBP' }, arjun, '2026-07-08T00:00:00Z');
  setStatus(db, 'itinerary_items', item, 'committed', arjun, '2026-07-08T00:00:00Z');
  openDecision(db, { question: 'Lock Skye for three nights?', mode: 'propose', options: ['yes', 'no'], stage: 'planning', openedBy: arjun }, '2026-07-08T00:00:00Z');
  addNote(db, { authorMemberId: arjun, topic: 'booking', note: 'Need ferry timing check' }, '2026-07-08T00:00:00Z');
  db.close();
  return dbPath;
}

describe('master compose', () => {
  test('composes generated hero/plan/ops sections from trip.db while preserving prose blocks', () => {
    const dbPath = seed();
    mkdirSync(join(dir, 'blocks', 'scotland'), { recursive: true });
    writeFileSync(join(dir, 'blocks', 'scotland', 'food.html'), '<p>Vegetarian breakfast notes. See §day-1 and §stays-portree.</p>');
    const res = composeMaster({ dbPath, slug: 'scotland', dir, date: '2026-07-08', hosted: true });
    const html = readFileSync(res.path, 'utf8');
    expect(html).toContain('Scotland 2026 — Master Document');
    expect(html).toContain('#day-1');
    expect(html).toContain('#stays-portree');
    expect(html).toContain('Old Man of Storr');
    expect(html).toContain('Lock Skye for three nights?');
    expect(html).toContain('Vegetarian breakfast notes. See #day-1 and #stays-portree.');
    expect(html).not.toContain('§');
    expect(html).toContain('Quick summary');
    expect(html).toContain('href="#route"');
    expect(html).toContain('href="#stays"');
    expect(html).toContain('href="#day-1"');
    expect(html).toContain('Staying tonight');
    expect(html).toContain('open day route in Google Maps (distance + travel time)');
    expect(html).toContain('waypoints=');
    expect(html).toContain('Old Man of Storr');
    expect(html).toContain('route-strip'); // schematic SVG map is always present
    expect(html.indexOf('id="summary"')).toBeLessThan(html.indexOf('id="map"'));
    expect(res.warnings).toEqual([]);
  });

  test('hosted compose embeds the Leaflet geographic map; local compose does not', () => {
    const dbPath = seed();
    const hosted = composeMaster({ dbPath, slug: 'scotland', dir, date: '2026-07-08', hosted: true });
    let html = readFileSync(hosted.path, 'utf8');
    expect(html).toContain('leaflet@1.9.4');
    expect(html).toContain('geo-map-canvas');
    expect(html).toContain('integrity="sha256-'); // SRI-pinned CDN assets
    const local = composeMaster({ dbPath, slug: 'scotland', dir, date: '2026-07-08' });
    html = readFileSync(local.path, 'utf8');
    expect(html).not.toContain('leaflet@1.9.4');
    expect(html).toContain('route-strip'); // strip carries the map in local/PDF output
  });

  test('refuses to overwrite hand-edited generated regions', () => {
    const dbPath = seed();
    const res = composeMaster({ dbPath, slug: 'scotland', dir, date: '2026-07-08' });
    const html = readFileSync(res.path, 'utf8').replace('Route map', 'Hand edited route map');
    writeFileSync(res.path, html);
    expect(() => composeMaster({ dbPath, slug: 'scotland', dir, date: '2026-07-08' })).toThrow(/generated region "hero" was edited/);
  });

  test('--rebuild regenerates the shell but preserves version and revision history', () => {
    const dbPath = seed();
    const first = composeMaster({ dbPath, slug: 'scotland', dir, date: '2026-07-08' });
    // Simulate a couple of bumps on the live doc.
    let html = readFileSync(first.path, 'utf8');
    html = bump(html, 'added Skye stays', '2026-07-09').html;
    html = bump(html, 'locked route', '2026-07-10').html;
    writeFileSync(first.path, html);
    // Damage a generated region by hand, then rebuild: must succeed and keep history.
    writeFileSync(first.path, readFileSync(first.path, 'utf8').replace('Route map', 'Hand edited'));
    const rebuilt = composeMaster({ dbPath, slug: 'scotland', dir, date: '2026-07-11', rebuild: true });
    expect(rebuilt.version).toBe(3);
    const out = summarize(readFileSync(rebuilt.path, 'utf8'));
    expect(out.version).toBe(3);
    expect(out.revisions.map((r) => r.summary)).toContain('locked route');
    expect(out.revisions.map((r) => r.summary)).toContain('added Skye stays');
  });
});

describe('recap compose', () => {
  test('renders deterministic keepsake content without balances or debts', () => {
    const dbPath = seed();
    const db = openPlanningDb(dbPath);
    const day = db.query("SELECT id FROM days WHERE date='2026-09-04'").get() as { id: number };
    setStatus(db, 'days', day.id, 'committed', 1, '2026-07-08T00:00:00Z');
    const decision = openDecision(db, { question: '[superlative] Trip MVP?', mode: 'poll', options: ['Skye'], openedBy: 1 }, '2026-07-08T00:00:00Z');
    closeDecision(db, decision, 'Skye', '2026-07-08T01:00:00Z');
    addDiary(db, { date: '2026-09-04', entry: 'Peak views!', memberId: 1 }, 1, '2026-09-04T20:00:00Z');
    indexAsset(db, { kind: 'photo', label: 'Storr', path: 'assets/storr.jpg', dayDate: '2026-09-04', addedBy: 1 }, '2026-09-04T20:00:00Z'); db.close();
    mkdirSync(join(dir, 'blocks', 'recap'), { recursive: true }); writeFileSync(join(dir, 'blocks', 'recap', 'intro.html'), '<p>What a trip.</p>');
    const result = composeRecap({ dbPath, slug: 'recap', dir, date: '2026-09-08' }); const html = readFileSync(result.path, 'utf8');
    expect(html).toContain('Trip MVP?'); expect(html).toContain('Peak views!'); expect(html).toContain('assets/storr.jpg'); expect(html).toContain('What a trip.'); expect(html).not.toMatch(/balance|debt/i);
  });
});
