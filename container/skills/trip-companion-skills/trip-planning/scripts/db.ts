import type { Database } from 'bun:sqlite';
import { ensureColumn, migrateCore, openCoreDb } from '../../trip-core/scripts/db';

// trip-planning layers the dawn-to-dusk plan model (§7) into the SAME trip.db
// as trip-core. Every planning row carries a proposal `status`
// (candidate → shortlisted → committed | rejected), a `cost` (minor units,
// reusing finance's money model) + optional `currency` (defaults to the trip
// base), and links to a normalized `places` row. The committed set is what
// freezes into a `plan_versions` snapshot.

export const PLAN_TABLES = [
  'destinations',
  'legs',
  'transport_hops',
  'stays',
  'days',
  'itinerary_items',
  'meals',
  'events',
] as const;
export type PlanTable = (typeof PLAN_TABLES)[number];

export const PLAN_STATUSES = ['candidate', 'shortlisted', 'committed', 'rejected'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export function migratePlanning(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT,
      address TEXT,
      lat REAL,
      lng REAL,
      gmaps_place_id TEXT,
      map_url TEXT,
      rating REAL,
      review_count INTEGER,
      review_summary TEXT
    );

    CREATE TABLE IF NOT EXISTS destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id INTEGER REFERENCES places(id),
      order_index INTEGER NOT NULL DEFAULT 0,
      nights INTEGER NOT NULL DEFAULT 0,
      rationale TEXT,
      trivia TEXT,
      status TEXT NOT NULL DEFAULT 'candidate'
    );

    CREATE TABLE IF NOT EXISTS legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER REFERENCES members(id),
      from_place_id INTEGER REFERENCES places(id),
      to_place_id INTEGER REFERENCES places(id),
      mode TEXT,
      carrier TEXT,
      depart TEXT,
      arrive TEXT,
      cost INTEGER,
      currency TEXT,
      booking_url TEXT,
      ref TEXT,
      direction TEXT,
      status TEXT NOT NULL DEFAULT 'candidate'
    );

    CREATE TABLE IF NOT EXISTS transport_hops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_place_id INTEGER REFERENCES places(id),
      to_place_id INTEGER REFERENCES places(id),
      mode TEXT,
      depart TEXT,
      arrive TEXT,
      travel_minutes INTEGER,
      cost INTEGER,
      currency TEXT,
      booking_url TEXT,
      buffer INTEGER,
      status TEXT NOT NULL DEFAULT 'candidate'
    );

    CREATE TABLE IF NOT EXISTS stays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      destination_id INTEGER REFERENCES destinations(id),
      place_id INTEGER REFERENCES places(id),
      tier TEXT,
      check_in TEXT,
      check_out TEXT,
      nights INTEGER,
      cost_per_night INTEGER,
      currency TEXT,
      breakfast_included INTEGER NOT NULL DEFAULT 0,
      booking_url TEXT,
      status TEXT NOT NULL DEFAULT 'candidate'
    );

    CREATE TABLE IF NOT EXISTS days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      base_place_id INTEGER REFERENCES places(id),
      theme TEXT,
      daily_cost INTEGER,
      status TEXT NOT NULL DEFAULT 'candidate'
    );

    CREATE TABLE IF NOT EXISTS itinerary_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id),
      slot TEXT NOT NULL,
      start TEXT,
      end TEXT,
      place_id INTEGER REFERENCES places(id),
      type TEXT NOT NULL DEFAULT 'activity',
      title TEXT NOT NULL,
      travel_from_place_id INTEGER REFERENCES places(id),
      travel_mode TEXT,
      travel_minutes INTEGER,
      cost INTEGER,
      currency TEXT,
      booking_required INTEGER NOT NULL DEFAULT 0,
      booking_url TEXT,
      ticket_deadline TEXT,
      info_url TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'candidate'
    );

    CREATE TABLE IF NOT EXISTS meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id),
      slot TEXT NOT NULL,
      place_id INTEGER REFERENCES places(id),
      veg_ok INTEGER NOT NULL DEFAULT 1,
      cost INTEGER,
      currency TEXT,
      url TEXT,
      included_in_stay INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'candidate'
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      place_id INTEGER REFERENCES places(id),
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'attend',
      source_url TEXT,
      booking_required INTEGER NOT NULL DEFAULT 0,
      ticket_deadline TEXT,
      cost INTEGER,
      currency TEXT,
      status TEXT NOT NULL DEFAULT 'candidate'
    );

    CREATE TABLE IF NOT EXISTS plan_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      validated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS place_info (
      place_id INTEGER NOT NULL REFERENCES places(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source_url TEXT,
      updated_by INTEGER REFERENCES members(id),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (place_id, key)
    );
  `);
  ensureColumn(db, 'places', 'open_hours', 'open_hours TEXT');
  ensureColumn(db, 'trip', 'pace_cap_minutes', 'pace_cap_minutes INTEGER');
  ensureColumn(db, 'itinerary_items', 'alternate_for_item_id', 'alternate_for_item_id INTEGER');
  ensureColumn(db, 'stays', 'ref', 'ref TEXT');
}

/** Open a trip.db with core + planning tables migrated. */
export function openPlanningDb(path: string): Database {
  const db = openCoreDb(path);
  migratePlanning(db);
  return db;
}

export function baseCurrency(db: Database): string {
  const row = db.query('SELECT base_currency FROM trip WHERE id = 1').get() as { base_currency: string } | null;
  return row?.base_currency ?? 'INR';
}
