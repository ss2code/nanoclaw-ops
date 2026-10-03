import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import type {
  ActivityInput,
  ActivityView,
  IngestEnvelope,
  IngestPlaceInput,
  IngestResult,
  InterestState,
  MemberInput,
  MemberPlaceStateView,
  PlaceMediaView,
  PlaceMutation,
  PlaceEvidenceView,
  PlaceSourceView,
  PlaceView,
  RegionInput,
  RegionView,
  VerificationState,
  Visibility,
  VisitState,
} from './types';
import {
  clampConfidence,
  haversineMeters,
  makeId,
  normalizeTag,
  normalizeText,
  normalizeUrl,
  nowIso,
  parseStringArray,
  platformFromUrl,
  sha256,
  slugify,
  tokenSimilarity,
  validateCoordinates,
} from './util';

const SCHEMA_VERSION = 2;

export const DEFAULT_CATEGORIES = [
  { id: 'food-drink', label: 'Food & drink', aliases: ['food', 'restaurant', 'restaurants', 'eatery', 'eateries', 'cafe', 'cafes', 'bar', 'bakery'] },
  { id: 'nature-scenery', label: 'Nature & scenery', aliases: ['nature', 'park', 'garden', 'lake', 'beach', 'wildlife', 'viewpoint', 'waterfall'] },
  { id: 'hikes-walks-cycling', label: 'Hikes, walks & cycling', aliases: ['hike', 'hiking', 'walk', 'walking', 'trail', 'cycling', 'bike'] },
  { id: 'culture-history', label: 'Culture & history', aliases: ['culture', 'history', 'heritage', 'museum', 'architecture', 'monument', 'spiritual'] },
  { id: 'arts-entertainment', label: 'Arts & entertainment', aliases: ['art', 'arts', 'gallery', 'theatre', 'theater', 'music', 'cinema', 'entertainment', 'games'] },
  { id: 'nightlife', label: 'Nightlife', aliases: ['club', 'late-night', 'comedy'] },
  { id: 'shopping-markets', label: 'Shopping & markets', aliases: ['shopping', 'market', 'markets', 'bookshop', 'bookstore', 'boutique', 'crafts'] },
  { id: 'sports-adventure', label: 'Sports & adventure', aliases: ['sport', 'sports', 'adventure', 'climbing', 'kayaking'] },
  { id: 'wellness', label: 'Wellness', aliases: ['spa', 'yoga', 'meditation', 'retreat'] },
  { id: 'family-children', label: 'Family & children', aliases: ['family', 'children', 'kids', 'kid-friendly'] },
  { id: 'day-trips-drives', label: 'Day trips & drives', aliases: ['day-trip', 'day trip', 'drive', 'scenic drive', 'excursion'] },
  { id: 'staycations', label: 'Staycations', aliases: ['staycation', 'resort', 'local stay'] },
] as const;

export const DEFAULT_REGIONS: RegionInput[] = [
  {
    id: 'bangalore',
    name: 'Bangalore',
    countryCode: 'IN',
    timezone: 'Asia/Kolkata',
    aliases: [
      'bangalore', 'bengaluru', 'blr', 'indiranagar', 'koramangala', 'jayanagar', // pii-lint-allow: public locality aliases
      'basavanagudi', 'whitefield', 'malleshwaram', 'mg road', 'cubbon park',
    ],
    center: { lat: 12.9716, lng: 77.5946 },
    bounds: { minLat: 12.72, maxLat: 13.19, minLng: 77.32, maxLng: 77.89 },
  },
  {
    id: 'bay-area',
    name: 'Bay Area',
    countryCode: 'US',
    timezone: 'America/Los_Angeles',
    aliases: [
      'bay area', 'san francisco bay area', 'san francisco', 'sf', 'oakland',
      'berkeley', 'san jose', 'palo alto', 'mountain view', 'sunnyvale',
      'fremont', 'marin', 'east bay', 'south bay', 'peninsula',
    ],
    center: { lat: 37.5665, lng: -122.079 },
    bounds: { minLat: 36.85, maxLat: 38.9, minLng: -123.2, maxLng: -121.2 },
  },
];

interface StoreOptions {
  dbPath?: string;
}

interface PlaceRow {
  id: string;
  slug: string;
  canonical_name: string;
  normalized_name: string;
  region_id: string | null;
  address: string | null;
  locality: string | null;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;
  status: string;
  merged_into: string | null;
  verification_state: VerificationState;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface DuplicateCandidate {
  placeId: string;
  name: string;
  score: number;
  reason: string;
}

function assertInterest(value: string | undefined): InterestState | undefined {
  if (value == null) return undefined;
  if (!['want-to-go', 'maybe', 'not-for-me'].includes(value)) throw new Error(`invalid interest state: ${value}`);
  return value as InterestState;
}

function assertVisit(value: string | undefined): VisitState | undefined {
  if (value == null) return undefined;
  if (!['not-visited', 'visited', 'revisit'].includes(value)) throw new Error(`invalid visit state: ${value}`);
  return value as VisitState;
}

function assertVisibility(value: string | undefined): Visibility {
  if (value == null) return 'group';
  if (!['group', 'shareable'].includes(value)) throw new Error(`invalid visibility: ${value}`);
  return value as Visibility;
}

function assertRating(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('rating must be an integer from 1 to 5');
  return value;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

export class PlaceStore {
  readonly dir: string;
  readonly dbPath: string;
  readonly db: Database;

  constructor(dir: string, options: StoreOptions = {}) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.dbPath = resolve(options.dbPath ?? join(this.dir, 'places.db'));
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS regions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        country_code TEXT NOT NULL,
        timezone TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        center_lat REAL,
        center_lng REAL,
        min_lat REAL,
        max_lat REAL,
        min_lng REAL,
        max_lng REAL,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS places (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        region_id TEXT REFERENCES regions(id),
        address TEXT,
        locality TEXT,
        neighborhood TEXT,
        lat REAL,
        lng REAL,
        status TEXT NOT NULL DEFAULT 'active',
        merged_into TEXT REFERENCES places(id),
        verification_state TEXT NOT NULL DEFAULT 'unverified'
          CHECK(verification_state IN ('verified', 'provisional', 'unverified')),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS places_region_idx ON places(region_id, status);
      CREATE INDEX IF NOT EXISTS places_name_idx ON places(normalized_name);

      CREATE TABLE IF NOT EXISTS place_aliases (
        place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        PRIMARY KEY(place_id, normalized_alias)
      );

      CREATE TABLE IF NOT EXISTS place_categories (
        place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES categories(id),
        confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
        source TEXT NOT NULL DEFAULT 'agent',
        PRIMARY KEY(place_id, category_id)
      );

      CREATE TABLE IF NOT EXISTS place_tags (
        place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
        source TEXT NOT NULL DEFAULT 'agent',
        PRIMARY KEY(place_id, tag)
      );

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        url_hash TEXT UNIQUE,
        url TEXT,
        platform TEXT NOT NULL,
        title TEXT,
        author TEXT,
        shared_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS place_sources (
        place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        evidence_strength REAL NOT NULL DEFAULT 0.5 CHECK(evidence_strength >= 0 AND evidence_strength <= 1),
        extraction_note TEXT,
        PRIMARY KEY(place_id, source_id)
      );

      CREATE TABLE IF NOT EXISTS place_evidence (
        id TEXT PRIMARY KEY,
        place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        reference TEXT NOT NULL,
        normalized_reference TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'verification' CHECK(role IN ('verification')),
        created_at TEXT NOT NULL,
        UNIQUE(place_id, normalized_reference)
      );
      CREATE INDEX IF NOT EXISTS place_evidence_place_idx ON place_evidence(place_id, created_at);

      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        identity_hash TEXT NOT NULL UNIQUE,
        display_alias TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id),
        source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        interest TEXT CHECK(interest IN ('want-to-go', 'maybe', 'not-for-me')),
        visit_state TEXT CHECK(visit_state IN ('not-visited', 'visited', 'revisit')),
        rating INTEGER CHECK(rating BETWEEN 1 AND 5),
        body TEXT,
        visibility TEXT NOT NULL DEFAULT 'group' CHECK(visibility IN ('group', 'shareable')),
        source_message_hash TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activities_place_idx ON activities(place_id, occurred_at, recorded_at);

      CREATE TABLE IF NOT EXISTS member_place_state (
        place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id),
        interest TEXT CHECK(interest IN ('want-to-go', 'maybe', 'not-for-me')),
        visit_state TEXT NOT NULL DEFAULT 'not-visited'
          CHECK(visit_state IN ('not-visited', 'visited', 'revisit')),
        rating INTEGER CHECK(rating BETWEEN 1 AND 5),
        last_comment TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(place_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('remote-image', 'local-image', 'source-card')),
        url TEXT,
        local_path TEXT,
        alt TEXT NOT NULL DEFAULT '',
        attribution TEXT,
        visibility TEXT NOT NULL DEFAULT 'group' CHECK(visibility IN ('group', 'shareable')),
        checksum TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS external_mappings (
        system TEXT NOT NULL,
        place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        last_verified_at TEXT,
        PRIMARY KEY(system, external_id),
        UNIQUE(system, place_id)
      );

      CREATE TABLE IF NOT EXISTS ingest_runs (
        idempotency_key TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'dismissed')),
        resolution_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const at = nowIso();
    const seed = this.db.transaction(() => {
      this.db.query(`
        INSERT INTO schema_meta (key, value) VALUES ('schema_version', $value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run({ $value: String(SCHEMA_VERSION) });
      this.db.query(`
        INSERT INTO schema_meta (key, value) VALUES ('revision', '0')
        ON CONFLICT(key) DO NOTHING
      `).run();
      this.db.query(`
        INSERT INTO schema_meta (key, value) VALUES ('member_salt', $value)
        ON CONFLICT(key) DO NOTHING
      `).run({ $value: randomBytes(24).toString('hex') });

      const categoryStmt = this.db.query(`
        INSERT INTO categories (id, label, aliases_json, sort_order, active)
        VALUES ($id, $label, $aliases, $sort, 1)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          aliases_json = excluded.aliases_json,
          sort_order = excluded.sort_order
      `);
      DEFAULT_CATEGORIES.forEach((category, index) => categoryStmt.run({
        $id: category.id,
        $label: category.label,
        $aliases: JSON.stringify(category.aliases),
        $sort: index,
      }));

      for (const region of DEFAULT_REGIONS) this.upsertRegion(region, at, false);
    });
    seed();
  }

  schemaVersion(): number {
    const row = this.db.query(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string } | null;
    return Number(row?.value ?? 0);
  }

  revision(): number {
    const row = this.db.query(`SELECT value FROM schema_meta WHERE key = 'revision'`).get() as { value: string } | null;
    return Number(row?.value ?? 0);
  }

  private bumpRevision(): number {
    const next = this.revision() + 1;
    this.db.query(`UPDATE schema_meta SET value = $value WHERE key = 'revision'`).run({ $value: String(next) });
    return next;
  }

  /** Stable material-state fingerprint used to keep reingest revisions idempotent. */
  private materialFingerprint(): string {
    const tables = [
      'regions', 'categories', 'places', 'place_aliases', 'place_categories', 'place_tags',
      'sources', 'place_sources', 'place_evidence', 'members', 'activities',
      'member_place_state', 'media', 'external_mappings', 'review_items',
    ];
    const volatile = new Set(['created_at', 'updated_at', 'recorded_at', 'last_verified_at']);
    const snapshot = tables.map((table) => {
      const rows = this.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
      return [table, rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !volatile.has(key))))];
    });
    return sha256(JSON.stringify(snapshot));
  }

  upsertRegion(input: RegionInput, at = nowIso(), bump = true): RegionView {
    const id = slugify(input.id);
    const aliases = [...new Set([id, input.name, ...(input.aliases ?? [])].map(normalizeText).filter(Boolean))];
    if (!input.countryCode || !input.timezone || !input.name.trim()) throw new Error('region name, countryCode, and timezone are required');
    if (input.center) validateCoordinates(input.center.lat, input.center.lng);
    if (input.bounds) {
      validateCoordinates(input.bounds.minLat, input.bounds.minLng);
      validateCoordinates(input.bounds.maxLat, input.bounds.maxLng);
      if (input.bounds.minLat >= input.bounds.maxLat || input.bounds.minLng >= input.bounds.maxLng) {
        throw new Error('region bounds minimums must be below maximums');
      }
    }
    const prior = this.db.query(`SELECT created_at FROM regions WHERE id = $id`).get({ $id: id }) as { created_at: string } | null;
    this.db.query(`
      INSERT INTO regions (
        id, name, country_code, timezone, aliases_json,
        center_lat, center_lng, min_lat, max_lat, min_lng, max_lng,
        active, created_at, updated_at
      ) VALUES (
        $id, $name, $country, $timezone, $aliases,
        $centerLat, $centerLng, $minLat, $maxLat, $minLng, $maxLng,
        $active, $createdAt, $updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        country_code = excluded.country_code,
        timezone = excluded.timezone,
        aliases_json = excluded.aliases_json,
        center_lat = excluded.center_lat,
        center_lng = excluded.center_lng,
        min_lat = excluded.min_lat,
        max_lat = excluded.max_lat,
        min_lng = excluded.min_lng,
        max_lng = excluded.max_lng,
        active = excluded.active,
        updated_at = excluded.updated_at
    `).run({
      $id: id,
      $name: input.name.trim(),
      $country: input.countryCode.trim().toUpperCase(),
      $timezone: input.timezone.trim(),
      $aliases: JSON.stringify(aliases),
      $centerLat: input.center?.lat ?? null,
      $centerLng: input.center?.lng ?? null,
      $minLat: input.bounds?.minLat ?? null,
      $maxLat: input.bounds?.maxLat ?? null,
      $minLng: input.bounds?.minLng ?? null,
      $maxLng: input.bounds?.maxLng ?? null,
      $active: input.active === false ? 0 : 1,
      $createdAt: prior?.created_at ?? at,
      $updatedAt: at,
    });
    if (bump) this.bumpRevision();
    return this.getRegion(id);
  }

  listRegions(includeInactive = false): RegionView[] {
    const rows = this.db.query(`
      SELECT * FROM regions ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.regionFromRow(row));
  }

  getRegion(id: string): RegionView {
    const row = this.db.query(`SELECT * FROM regions WHERE id = $id`).get({ $id: slugify(id) }) as Record<string, unknown> | null;
    if (!row) throw new Error(`unknown region: ${id}`);
    return this.regionFromRow(row);
  }

  private regionFromRow(row: Record<string, unknown>): RegionView {
    const hasCenter = row.center_lat != null && row.center_lng != null;
    const hasBounds = row.min_lat != null && row.max_lat != null && row.min_lng != null && row.max_lng != null;
    return {
      id: String(row.id),
      name: String(row.name),
      countryCode: String(row.country_code),
      timezone: String(row.timezone),
      aliases: parseStringArray(row.aliases_json),
      ...(hasCenter ? { center: { lat: Number(row.center_lat), lng: Number(row.center_lng) } } : {}),
      ...(hasBounds ? {
        bounds: {
          minLat: Number(row.min_lat),
          maxLat: Number(row.max_lat),
          minLng: Number(row.min_lng),
          maxLng: Number(row.max_lng),
        },
      } : {}),
      active: Number(row.active) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  resolveRegion(place: IngestPlaceInput): { regionId?: string; confidence: number; reason: string } {
    const regions = this.listRegions();
    if (place.regionCandidate?.trim()) {
      const candidate = normalizeText(place.regionCandidate);
      const matches = regions.filter((region) =>
        normalizeText(region.id) === candidate ||
        normalizeText(region.name) === candidate ||
        region.aliases.includes(candidate));
      if (matches.length === 1) return { regionId: matches[0].id, confidence: 1, reason: 'explicit-region' };
      return { confidence: 0, reason: 'unknown-explicit-region' };
    }
    if (place.coordinates) {
      validateCoordinates(place.coordinates.lat, place.coordinates.lng);
      const matches = regions.filter((region) =>
        region.bounds &&
        place.coordinates!.lat >= region.bounds.minLat &&
        place.coordinates!.lat <= region.bounds.maxLat &&
        place.coordinates!.lng >= region.bounds.minLng &&
        place.coordinates!.lng <= region.bounds.maxLng);
      if (matches.length === 1) return { regionId: matches[0].id, confidence: 0.96, reason: 'coordinate-bounds' };
    }
    const text = normalizeText([place.address, place.locality, place.neighborhood].filter(Boolean).join(' '));
    if (text) {
      const scored = regions
        .map((region) => ({
          region,
          match: region.aliases.filter((alias) => alias.length >= 3 && (` ${text} `).includes(` ${alias} `)).sort((a, b) => b.length - a.length)[0],
        }))
        .filter((entry) => entry.match)
        .sort((a, b) => (b.match?.length ?? 0) - (a.match?.length ?? 0));
      if (scored.length === 1 || (scored[0]?.match?.length ?? 0) > (scored[1]?.match?.length ?? 0)) {
        return { regionId: scored[0].region.id, confidence: 0.88, reason: `location-alias:${scored[0].match}` };
      }
    }
    return { confidence: 0, reason: 'insufficient-location' };
  }

  private upsertMember(member: MemberInput, at: string): string {
    if (!member.localId?.trim() || !member.displayAlias?.trim()) throw new Error('member localId and displayAlias are required');
    const salt = (this.db.query(`SELECT value FROM schema_meta WHERE key = 'member_salt'`).get() as { value: string }).value;
    const identityHash = sha256(`${salt}:${member.localId.trim()}`);
    const existing = this.db.query(`SELECT id FROM members WHERE identity_hash = $hash`).get({ $hash: identityHash }) as { id: string } | null;
    const id = existing?.id ?? makeId('mem');
    this.db.query(`
      INSERT INTO members (id, identity_hash, display_alias, created_at, updated_at)
      VALUES ($id, $hash, $alias, $at, $at)
      ON CONFLICT(identity_hash) DO UPDATE SET display_alias = excluded.display_alias, updated_at = excluded.updated_at
    `).run({ $id: id, $hash: identityHash, $alias: member.displayAlias.trim().slice(0, 80), $at: at });
    return id;
  }

  private upsertSource(source: IngestEnvelope['source'], at: string): string | undefined {
    if (!source) return undefined;
    if (!source.url) {
      const id = makeId('src');
      this.db.query(`
        INSERT INTO sources (id, url_hash, url, platform, title, author, shared_at, created_at)
        VALUES ($id, NULL, NULL, $platform, $title, $author, $sharedAt, $at)
      `).run({
        $id: id,
        $platform: source.platform?.trim() || 'user',
        $title: source.title?.trim().slice(0, 300) || null,
        $author: source.author?.trim().slice(0, 160) || null,
        $sharedAt: source.sharedAt ? nowIso(source.sharedAt) : at,
        $at: at,
      });
      return id;
    }
    const url = normalizeUrl(source.url);
    const hash = sha256(url);
    const existing = this.db.query(`SELECT id FROM sources WHERE url_hash = $hash`).get({ $hash: hash }) as { id: string } | null;
    if (existing) return existing.id;
    const id = makeId('src');
    this.db.query(`
      INSERT INTO sources (id, url_hash, url, platform, title, author, shared_at, created_at)
      VALUES ($id, $hash, $url, $platform, $title, $author, $sharedAt, $at)
    `).run({
      $id: id,
      $hash: hash,
      $url: url,
      $platform: source.platform?.trim() || platformFromUrl(url),
      $title: source.title?.trim().slice(0, 300) || null,
      $author: source.author?.trim().slice(0, 160) || null,
      $sharedAt: source.sharedAt ? nowIso(source.sharedAt) : at,
      $at: at,
    });
    return id;
  }

  private validateEnvelope(envelope: IngestEnvelope): void {
    if (envelope.ingestVersion !== 1) throw new Error('ingestVersion must be 1');
    if (!envelope.idempotencyKey?.trim() || envelope.idempotencyKey.length > 300) {
      throw new Error('idempotencyKey is required and must be at most 300 characters');
    }
    if (!Array.isArray(envelope.places) || envelope.places.length < 1 || envelope.places.length > 50) {
      throw new Error('places must contain between 1 and 50 entries');
    }
    if (!envelope.member?.localId || !envelope.member?.displayAlias) throw new Error('member is required');
    for (const place of envelope.places) {
      if (!place.name?.trim() || place.name.trim().length > 200) throw new Error('every place requires a name of at most 200 characters');
      if (place.coordinates) validateCoordinates(place.coordinates.lat, place.coordinates.lng);
      const references = place.verification?.references;
      if (references != null) {
        if (!Array.isArray(references) || references.length > 50 || references.some((reference) => typeof reference !== 'string' || !reference.trim())) {
          throw new Error(`verification references for ${place.name} must contain at most 50 non-empty strings`);
        }
      }
      const activity = place.activity;
      if (activity) {
        assertInterest(activity.interest);
        const visit = assertVisit(activity.visitState);
        const rating = assertRating(activity.rating);
        assertVisibility(activity.visibility);
        if (rating != null && !['visited', 'revisit'].includes(visit ?? '')) {
          throw new Error(`rating for ${place.name} requires visitState=visited or revisit`);
        }
      }
    }
  }

  ingest(envelope: IngestEnvelope, options: { reingest?: boolean } = {}): IngestResult {
    this.validateEnvelope(envelope);
    const key = envelope.idempotencyKey.trim();
    const existing = this.db.query(`
      SELECT status, result_json FROM ingest_runs WHERE idempotency_key = $key
    `).get({ $key: key }) as { status: string; result_json: string | null } | null;
    if (existing?.status === 'completed' && existing.result_json && !options.reingest) {
      const prior = JSON.parse(existing.result_json) as IngestResult;
      return { ...prior, replayed: true };
    }

    const at = nowIso();
    const beforeFingerprint = this.materialFingerprint();
    try {
      const transaction = this.db.transaction(() => {
        this.db.query(`
          INSERT INTO ingest_runs (idempotency_key, status, result_json, error, created_at, updated_at)
          VALUES ($key, 'running', NULL, NULL, $at, $at)
          ON CONFLICT(idempotency_key) DO UPDATE SET status = 'running', error = NULL, updated_at = excluded.updated_at
        `).run({ $key: key, $at: at });
        const memberId = this.upsertMember(envelope.member, at);
        const sourceId = this.upsertSource(envelope.source, at);
        const mutations: PlaceMutation[] = [];
        const warnings: string[] = [];
        const affected = new Set<string>();

        envelope.places.forEach((place, inputIndex) => {
          const mutation = this.ingestOnePlace({
            envelope,
            place,
            inputIndex,
            memberId,
            sourceId,
            at,
          });
          mutations.push(mutation);
          if (mutation.regionId && mutation.status !== 'review') affected.add(mutation.regionId);
          warnings.push(...mutation.warnings);
        });

        const changed = this.materialFingerprint() !== beforeFingerprint;
        const revision = changed ? this.bumpRevision() : this.revision();
        const result: IngestResult = {
          ok: mutations.some((mutation) => mutation.status !== 'review'),
          replayed: Boolean(options.reingest && !changed),
          revision,
          affectedRegions: [...affected].sort(),
          mutations,
          warnings: [...new Set(warnings)],
        };
        this.db.query(`
          UPDATE ingest_runs SET status = 'completed', result_json = $result, updated_at = $at
          WHERE idempotency_key = $key
        `).run({ $result: JSON.stringify(result), $at: at, $key: key });
        return result;
      });
      return transaction();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.query(`
        INSERT INTO ingest_runs (idempotency_key, status, result_json, error, created_at, updated_at)
        VALUES ($key, 'failed', NULL, $error, $at, $at)
        ON CONFLICT(idempotency_key) DO UPDATE SET status = 'failed', error = excluded.error, updated_at = excluded.updated_at
      `).run({ $key: key, $error: message.slice(0, 1000), $at: at });
      throw error;
    }
  }

  private ingestOnePlace(args: {
    envelope: IngestEnvelope;
    place: IngestPlaceInput;
    inputIndex: number;
    memberId: string;
    sourceId?: string;
    at: string;
  }): PlaceMutation {
    const { envelope, place, inputIndex, memberId, sourceId, at } = args;
    const warnings: string[] = [];
    const region = this.resolveRegion(place);
    if (!region.regionId) {
      const reviewId = this.createReview(
        `region:${region.reason}`,
        { ...envelope, places: [place] },
        [],
        at,
      );
      return { inputIndex, status: 'review', placeName: place.name.trim(), reviewId, warnings: ['location needs review'] };
    }

    const explicitExisting = place.id
      ? this.db.query(`SELECT id, canonical_name FROM places WHERE id = $id AND status != 'merged'`)
        .get({ $id: place.id }) as { id: string; canonical_name: string } | null
      : null;
    const candidates = place.forceNew
      ? []
      : explicitExisting
        ? [{ placeId: explicitExisting.id, name: explicitExisting.canonical_name, score: 1, reason: 'explicit-place-id' }]
        : this.findDuplicateCandidates(place, region.regionId, sourceId);
    const top = candidates[0];
    if (top && top.score >= 0.68 && top.score < 0.9) {
      const reviewId = this.createReview('possible-duplicate', { ...envelope, places: [place] }, candidates, at);
      return {
        inputIndex,
        status: 'review',
        placeName: place.name.trim(),
        regionId: region.regionId,
        reviewId,
        warnings: [`possible duplicate: ${top.name}`],
      };
    }

    const existingId = top?.score && top.score >= 0.9 ? top.placeId : undefined;
    const placeId = existingId ?? place.id ?? makeId('plc');
    const confidence = clampConfidence(place.verification?.confidence ?? region.confidence);
    const verificationState = place.verification?.state ?? (confidence >= 0.85 ? 'verified' : 'provisional');

    if (existingId) {
      this.updateExistingPlace(existingId, place, region.regionId, verificationState, confidence, at);
    } else {
      this.db.query(`
        INSERT INTO places (
          id, slug, canonical_name, normalized_name, region_id, address, locality, neighborhood,
          lat, lng, status, merged_into, verification_state, confidence, created_at, updated_at
        ) VALUES (
          $id, $slug, $name, $normalized, $region, $address, $locality, $neighborhood,
          $lat, $lng, 'active', NULL, $verification, $confidence, $at, $at
        )
      `).run({
        $id: placeId,
        $slug: slugify(place.name),
        $name: place.name.trim(),
        $normalized: normalizeText(place.name),
        $region: region.regionId,
        $address: place.address?.trim() || null,
        $locality: place.locality?.trim() || null,
        $neighborhood: place.neighborhood?.trim() || null,
        $lat: place.coordinates?.lat ?? null,
        $lng: place.coordinates?.lng ?? null,
        $verification: verificationState,
        $confidence: confidence,
        $at: at,
      });
    }

    this.addAliases(placeId, place.aliases ?? []);
    warnings.push(...this.addCategoriesAndTags(placeId, place.categories ?? [], place.tags ?? []));
    this.addEvidence(placeId, place.verification?.references ?? [], at);
    if (sourceId) {
      this.db.query(`
        INSERT INTO place_sources (place_id, source_id, evidence_strength, extraction_note)
        VALUES ($place, $source, $strength, NULL)
        ON CONFLICT(place_id, source_id) DO UPDATE SET
          evidence_strength = MAX(place_sources.evidence_strength, excluded.evidence_strength)
      `).run({ $place: placeId, $source: sourceId, $strength: confidence });
    }
    for (const [system, externalId] of Object.entries(place.externalIds ?? {})) {
      if (!system.trim() || !externalId.trim()) continue;
      this.db.query(`
        INSERT INTO external_mappings (system, place_id, external_id, last_verified_at)
        VALUES ($system, $place, $external, $at)
        ON CONFLICT(system, external_id) DO UPDATE SET place_id = excluded.place_id, last_verified_at = excluded.last_verified_at
      `).run({ $system: normalizeTag(system), $place: placeId, $external: externalId.trim(), $at: at });
    }
    this.addMedia(placeId, place.media ?? [], at);
    this.addActivity(placeId, memberId, sourceId, place.activity ?? { type: 'saved' }, sha256(envelope.idempotencyKey), at);
    this.db.query(`UPDATE places SET updated_at = $at WHERE id = $id`).run({ $at: at, $id: placeId });

    return {
      inputIndex,
      status: existingId ? 'updated' : 'created',
      placeId,
      placeName: place.name.trim(),
      regionId: region.regionId,
      warnings,
    };
  }

  private updateExistingPlace(
    id: string,
    input: IngestPlaceInput,
    regionId: string,
    verification: VerificationState,
    confidence: number,
    at: string,
  ): void {
    const row = this.db.query(`SELECT * FROM places WHERE id = $id`).get({ $id: id }) as PlaceRow | null;
    if (!row) throw new Error(`duplicate candidate disappeared: ${id}`);
    const useNewVerification = confidence >= row.confidence;
    this.db.query(`
      UPDATE places SET
        region_id = COALESCE(region_id, $region),
        address = COALESCE(address, $address),
        locality = COALESCE(locality, $locality),
        neighborhood = COALESCE(neighborhood, $neighborhood),
        lat = COALESCE(lat, $lat),
        lng = COALESCE(lng, $lng),
        verification_state = $verification,
        confidence = $confidence,
        updated_at = $at
      WHERE id = $id
    `).run({
      $region: regionId,
      $address: input.address?.trim() || null,
      $locality: input.locality?.trim() || null,
      $neighborhood: input.neighborhood?.trim() || null,
      $lat: input.coordinates?.lat ?? null,
      $lng: input.coordinates?.lng ?? null,
      $verification: useNewVerification ? verification : row.verification_state,
      $confidence: Math.max(confidence, row.confidence),
      $at: at,
      $id: id,
    });
  }

  private addAliases(placeId: string, aliases: string[]): void {
    const statement = this.db.query(`
      INSERT OR IGNORE INTO place_aliases (place_id, alias, normalized_alias)
      VALUES ($place, $alias, $normalized)
    `);
    for (const alias of aliases.map((value) => value.trim()).filter(Boolean)) {
      statement.run({ $place: placeId, $alias: alias.slice(0, 200), $normalized: normalizeText(alias) });
    }
  }

  private canonicalCategory(value: string): string | undefined {
    const normalized = normalizeText(value);
    for (const category of DEFAULT_CATEGORIES) {
      if (normalizeText(category.id) === normalized || normalizeText(category.label) === normalized) return category.id;
      if ((category.aliases as readonly string[]).some((alias) => normalizeText(alias) === normalized)) return category.id;
    }
    return undefined;
  }

  private addCategoriesAndTags(placeId: string, categories: string[], tags: string[]): string[] {
    const warnings: string[] = [];
    const categoryStmt = this.db.query(`
      INSERT OR IGNORE INTO place_categories (place_id, category_id, confidence, source)
      VALUES ($place, $category, 1, 'agent')
    `);
    const tagValues = [...tags];
    for (const value of categories) {
      const category = this.canonicalCategory(value);
      if (category) categoryStmt.run({ $place: placeId, $category: category });
      else {
        tagValues.push(value);
        warnings.push(`unknown category "${value}" stored as a tag`);
      }
    }
    const tagStmt = this.db.query(`
      INSERT OR IGNORE INTO place_tags (place_id, tag, confidence, source)
      VALUES ($place, $tag, 1, 'agent')
    `);
    for (const value of tagValues) {
      try {
        tagStmt.run({ $place: placeId, $tag: normalizeTag(value) });
      } catch {
        warnings.push(`ignored invalid tag "${value}"`);
      }
    }
    return warnings;
  }

  private addMedia(placeId: string, media: NonNullable<IngestPlaceInput['media']>, at: string): void {
    for (const item of media.slice(0, 20)) {
      const visibility = assertVisibility(item.visibility);
      let url: string | null = null;
      if (item.url) url = normalizeUrl(item.url);
      if (item.kind === 'remote-image' && !url) throw new Error('remote-image media requires url');
      if (item.kind === 'local-image' && !item.localPath) throw new Error('local-image media requires localPath');
      const existing = this.db.query(`
        SELECT id FROM media
        WHERE place_id = $place AND kind = $kind
          AND COALESCE(url, '') = COALESCE($url, '')
          AND COALESCE(local_path, '') = COALESCE($path, '')
      `).get({ $place: placeId, $kind: item.kind, $url: url, $path: item.localPath?.trim() || null });
      if (existing) continue;
      this.db.query(`
        INSERT INTO media (id, place_id, kind, url, local_path, alt, attribution, visibility, checksum, created_at)
        VALUES ($id, $place, $kind, $url, $path, $alt, $attribution, $visibility, NULL, $at)
      `).run({
        $id: makeId('med'),
        $place: placeId,
        $kind: item.kind,
        $url: url,
        $path: item.localPath?.trim() || null,
        $alt: item.alt?.trim().slice(0, 300) || '',
        $attribution: item.attribution?.trim().slice(0, 300) || null,
        $visibility: visibility,
        $at: at,
      });
    }
  }

  private addEvidence(placeId: string, references: string[], at: string): void {
    for (const raw of references.slice(0, 50)) {
      const reference = raw.trim().slice(0, 2000);
      const normalized = normalizeText(reference);
      if (!normalized) continue;
      this.db.query(`
        INSERT OR IGNORE INTO place_evidence (id, place_id, reference, normalized_reference, role, created_at)
        VALUES ($id, $place, $reference, $normalized, 'verification', $at)
      `).run({ $id: makeId('ev'), $place: placeId, $reference: reference, $normalized: normalized, $at: at });
    }
  }

  private addActivity(
    placeId: string,
    memberId: string,
    sourceId: string | undefined,
    input: ActivityInput,
    sourceMessageHash: string | undefined,
    at: string,
  ): string {
    const interest = assertInterest(input.interest);
    const visitState = assertVisit(input.visitState);
    const rating = assertRating(input.rating);
    const visibility = assertVisibility(input.visibility);
    const current = this.db.query(`
      SELECT visit_state FROM member_place_state WHERE place_id = $place AND member_id = $member
    `).get({ $place: placeId, $member: memberId }) as { visit_state: VisitState } | null;
    const resultingVisit = visitState ?? current?.visit_state ?? 'not-visited';
    if (rating != null && !['visited', 'revisit'].includes(resultingVisit)) {
      throw new Error('rating requires the member to be visited or revisit');
    }
    const id = makeId('act');
    const occurredAt = nowIso(input.occurredAt ?? at);
    const comment = input.comment?.trim().slice(0, 4000) || null;
    if (sourceMessageHash) {
      const prior = this.db.query(`
        SELECT id, source_id, interest, visit_state, rating, body, visibility, type FROM activities
        WHERE place_id = $place AND member_id = $member AND source_message_hash = $messageHash
        ORDER BY recorded_at DESC LIMIT 1
      `).get({ $place: placeId, $member: memberId, $messageHash: sourceMessageHash }) as {
        id: string;
        source_id: string | null;
        interest: InterestState | null;
        visit_state: VisitState | null;
        rating: number | null;
        body: string | null;
        visibility: Visibility;
        type: string;
      } | null;
      if (prior) {
        this.db.query(`
          UPDATE activities SET
            source_id = COALESCE(source_id, $source),
            type = COALESCE(NULLIF($type, ''), type),
            interest = COALESCE(interest, $interest),
            visit_state = COALESCE(visit_state, $visit),
            rating = COALESCE(rating, $rating),
            body = COALESCE(body, $body),
            visibility = CASE WHEN visibility = 'group' AND $visibility = 'shareable' THEN 'shareable' ELSE visibility END
          WHERE id = $id
        `).run({
          $source: sourceId ?? null,
          $type: input.type?.trim().slice(0, 60) || '',
          $interest: interest ?? null,
          $visit: visitState ?? null,
          $rating: rating ?? null,
          $body: comment,
          $visibility: visibility,
          $id: prior.id,
        });
        this.projectMemberState(placeId, memberId);
        return prior.id;
      }
    }
    this.db.query(`
      INSERT INTO activities (
        id, place_id, member_id, source_id, type, interest, visit_state, rating, body,
        visibility, source_message_hash, occurred_at, recorded_at
      ) VALUES (
        $id, $place, $member, $source, $type, $interest, $visit, $rating, $body,
        $visibility, $messageHash, $occurredAt, $recordedAt
      )
    `).run({
      $id: id,
      $place: placeId,
      $member: memberId,
      $source: sourceId ?? null,
      $type: input.type?.trim().slice(0, 60) || 'saved',
      $interest: interest ?? null,
      $visit: visitState ?? null,
      $rating: rating ?? null,
      $body: comment,
      $visibility: visibility,
      $messageHash: sourceMessageHash ?? null,
      $occurredAt: occurredAt,
      $recordedAt: at,
    });
    this.projectMemberState(placeId, memberId);
    return id;
  }

  private projectMemberState(placeId: string, memberId: string): void {
    const activities = this.db.query(`
      SELECT interest, visit_state, rating, body, occurred_at, recorded_at
      FROM activities
      WHERE place_id = $place AND member_id = $member
      ORDER BY occurred_at, recorded_at, id
    `).all({ $place: placeId, $member: memberId }) as Array<{
      interest: InterestState | null;
      visit_state: VisitState | null;
      rating: number | null;
      body: string | null;
      occurred_at: string;
      recorded_at: string;
    }>;
    let interest: InterestState | null = null;
    let visitState: VisitState = 'not-visited';
    let rating: number | null = null;
    let lastComment: string | null = null;
    let updatedAt = nowIso();
    for (const activity of activities) {
      if (activity.interest != null) interest = activity.interest;
      if (activity.visit_state != null) visitState = activity.visit_state;
      if (activity.rating != null) rating = activity.rating;
      if (activity.body != null) lastComment = activity.body;
      updatedAt = activity.recorded_at;
    }
    this.db.query(`
      INSERT INTO member_place_state (
        place_id, member_id, interest, visit_state, rating, last_comment, updated_at
      ) VALUES ($place, $member, $interest, $visit, $rating, $comment, $updatedAt)
      ON CONFLICT(place_id, member_id) DO UPDATE SET
        interest = excluded.interest,
        visit_state = excluded.visit_state,
        rating = excluded.rating,
        last_comment = excluded.last_comment,
        updated_at = excluded.updated_at
    `).run({
      $place: placeId,
      $member: memberId,
      $interest: interest,
      $visit: visitState,
      $rating: rating,
      $comment: lastComment,
      $updatedAt: updatedAt,
    });
  }

  private findDuplicateCandidates(place: IngestPlaceInput, regionId: string, sourceId?: string): DuplicateCandidate[] {
    if (place.externalIds) {
      for (const [system, externalId] of Object.entries(place.externalIds)) {
        const mapped = this.db.query(`
          SELECT p.id, p.canonical_name
          FROM external_mappings em JOIN places p ON p.id = em.place_id
          WHERE em.system = $system AND em.external_id = $external AND p.status != 'merged'
        `).get({ $system: normalizeTag(system), $external: externalId.trim() }) as { id: string; canonical_name: string } | null;
        if (mapped) return [{ placeId: mapped.id, name: mapped.canonical_name, score: 1, reason: 'external-id' }];
      }
    }

    const rows = this.db.query(`
      SELECT DISTINCT p.*
      FROM places p
      LEFT JOIN place_sources ps ON ps.place_id = p.id
      WHERE p.region_id = $region AND p.status != 'merged'
        AND ($source IS NULL OR ps.source_id = $source OR p.normalized_name = $name)
    `).all({
      $region: regionId,
      $source: sourceId ?? null,
      $name: normalizeText(place.name),
    }) as PlaceRow[];

    const candidates: DuplicateCandidate[] = [];
    for (const row of rows) {
      const similarity = tokenSimilarity(place.name, row.canonical_name);
      const sameName = normalizeText(place.name) === row.normalized_name;
      const sameAddress = Boolean(place.address && row.address && normalizeText(place.address) === normalizeText(row.address));
      const sameLocality = Boolean(place.locality && row.locality && normalizeText(place.locality) === normalizeText(row.locality));
      const coordinates =
        place.coordinates && row.lat != null && row.lng != null
          ? haversineMeters(place.coordinates, { lat: row.lat, lng: row.lng })
          : undefined;
      let score = 0;
      let reason = 'weak-name';
      if (sourceId) {
        const linked = this.db.query(`
          SELECT 1 FROM place_sources WHERE place_id = $place AND source_id = $source
        `).get({ $place: row.id, $source: sourceId });
        if (linked && sameName) {
          score = 0.98;
          reason = 'same-source';
        }
      }
      if (sameName && sameAddress) {
        score = Math.max(score, 0.98);
        reason = 'same-name-address';
      } else if (coordinates != null && coordinates <= 100 && similarity >= 0.5) {
        score = Math.max(score, 0.96);
        reason = 'nearby-name';
      } else if (sameName && sameLocality) {
        score = Math.max(score, 0.92);
        reason = 'same-name-locality';
      } else if (sameName) {
        score = Math.max(score, 0.76);
        reason = 'same-name-region';
      } else if (similarity >= 0.8 && sameLocality) {
        score = Math.max(score, 0.72);
        reason = 'similar-name-locality';
      }
      if (score > 0) candidates.push({ placeId: row.id, name: row.canonical_name, score, reason });
    }
    return candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  private createReview(reason: string, payload: unknown, candidates: unknown, at: string): string {
    const id = makeId('rev');
    this.db.query(`
      INSERT INTO review_items (
        id, reason, payload_json, candidates_json, status, resolution_json, created_at, updated_at
      ) VALUES ($id, $reason, $payload, $candidates, 'open', NULL, $at, $at)
    `).run({
      $id: id,
      $reason: reason,
      $payload: JSON.stringify(payload),
      $candidates: JSON.stringify(candidates),
      $at: at,
    });
    return id;
  }

  listReviewItems(): unknown[] {
    const rows = this.db.query(`
      SELECT * FROM review_items WHERE status = 'open' ORDER BY created_at
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      payload: JSON.parse(String(row.payload_json)),
      candidates: JSON.parse(String(row.candidates_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  resolveReview(
    reviewId: string,
    options: { regionId?: string; usePlaceId?: string; forceNew?: boolean },
  ): IngestResult {
    const row = this.db.query(`
      SELECT * FROM review_items WHERE id = $id AND status = 'open'
    `).get({ $id: reviewId }) as { payload_json: string } | null;
    if (!row) throw new Error(`open review item not found: ${reviewId}`);
    const envelope = JSON.parse(row.payload_json) as IngestEnvelope;
    envelope.idempotencyKey = `${envelope.idempotencyKey}:review:${reviewId}`;
    if (options.regionId) envelope.places[0].regionCandidate = options.regionId;
    if (options.forceNew) envelope.places[0].forceNew = true;
    if (options.usePlaceId) {
      const existing = this.db.query(`SELECT id, region_id FROM places WHERE id = $id AND status != 'merged'`).get({ $id: options.usePlaceId }) as { id: string; region_id: string | null } | null;
      if (!existing) throw new Error(`place not found: ${options.usePlaceId}`);
      envelope.places[0].id = existing.id;
      envelope.places[0].regionCandidate = existing.region_id ?? options.regionId;
      envelope.places[0].forceNew = false;
    }
    const result = this.ingest(envelope);
    this.db.query(`
      UPDATE review_items SET status = 'resolved', resolution_json = $result, updated_at = $at WHERE id = $id
    `).run({ $result: JSON.stringify(result), $at: nowIso(), $id: reviewId });
    return result;
  }

  addMemberActivity(
    placeId: string,
    member: MemberInput,
    activity: ActivityInput,
    idempotencyKey: string,
  ): IngestResult {
    const place = this.db.query(`SELECT * FROM places WHERE id = $id AND status != 'merged'`).get({ $id: placeId }) as PlaceRow | null;
    if (!place) throw new Error(`place not found: ${placeId}`);
    return this.ingest({
      ingestVersion: 1,
      idempotencyKey,
      member,
      places: [{
        name: place.canonical_name,
        address: place.address ?? undefined,
        locality: place.locality ?? undefined,
        neighborhood: place.neighborhood ?? undefined,
        coordinates: place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : undefined,
        regionCandidate: place.region_id ?? undefined,
        externalIds: { 'save-places': placeId },
        activity,
      }],
    });
  }

  correctPlace(
    placeId: string,
    changes: Partial<{
      name: string;
      address: string;
      locality: string;
      neighborhood: string;
      coordinates: { lat: number; lng: number };
      regionId: string;
      status: string;
      verificationState: VerificationState;
      confidence: number;
    }>,
    member: MemberInput,
    comment: string,
  ): { ok: true; placeId: string; affectedRegions: string[]; revision: number } {
    const prior = this.db.query(`SELECT * FROM places WHERE id = $id AND status != 'merged'`).get({ $id: placeId }) as PlaceRow | null;
    if (!prior) throw new Error(`place not found: ${placeId}`);
    if (changes.coordinates) validateCoordinates(changes.coordinates.lat, changes.coordinates.lng);
    const regionId = changes.regionId ? this.getRegion(changes.regionId).id : prior.region_id;
    const name = changes.name?.trim() || prior.canonical_name;
    const at = nowIso();
    const transaction = this.db.transaction(() => {
      this.db.query(`
        UPDATE places SET
          canonical_name = $name,
          normalized_name = $normalized,
          slug = $slug,
          region_id = $region,
          address = $address,
          locality = $locality,
          neighborhood = $neighborhood,
          lat = $lat,
          lng = $lng,
          status = $status,
          verification_state = $verification,
          confidence = $confidence,
          updated_at = $at
        WHERE id = $id
      `).run({
        $name: name,
        $normalized: normalizeText(name),
        $slug: slugify(name),
        $region: regionId,
        $address: changes.address ?? prior.address,
        $locality: changes.locality ?? prior.locality,
        $neighborhood: changes.neighborhood ?? prior.neighborhood,
        $lat: changes.coordinates?.lat ?? prior.lat,
        $lng: changes.coordinates?.lng ?? prior.lng,
        $status: changes.status ?? prior.status,
        $verification: changes.verificationState ?? prior.verification_state,
        $confidence: changes.confidence == null ? prior.confidence : clampConfidence(changes.confidence),
        $at: at,
        $id: placeId,
      });
      const memberId = this.upsertMember(member, at);
      this.addActivity(placeId, memberId, undefined, { type: 'correction', comment, visibility: 'group' }, undefined, at);
      return this.bumpRevision();
    });
    const revision = transaction();
    return {
      ok: true,
      placeId,
      affectedRegions: [...new Set([prior.region_id, regionId].filter((value): value is string => Boolean(value)))],
      revision,
    };
  }

  mergePlaces(keepId: string, mergeId: string, member: MemberInput, reason: string): { ok: true; placeId: string; revision: number; affectedRegions: string[] } {
    if (keepId === mergeId) throw new Error('keep and merge IDs must differ');
    const keep = this.db.query(`SELECT * FROM places WHERE id = $id AND status != 'merged'`).get({ $id: keepId }) as PlaceRow | null;
    const merge = this.db.query(`SELECT * FROM places WHERE id = $id AND status != 'merged'`).get({ $id: mergeId }) as PlaceRow | null;
    if (!keep || !merge) throw new Error('both active places must exist');
    const at = nowIso();
    const transaction = this.db.transaction(() => {
      for (const table of ['place_aliases', 'place_categories', 'place_tags', 'place_sources', 'place_evidence'] as const) {
        const columns = {
          place_aliases: 'alias, normalized_alias',
          place_categories: 'category_id, confidence, source',
          place_tags: 'tag, confidence, source',
          place_sources: 'source_id, evidence_strength, extraction_note',
          place_evidence: 'id, reference, normalized_reference, role, created_at',
        }[table];
        this.db.query(`
          INSERT OR IGNORE INTO ${table} (place_id, ${columns})
          SELECT $keep, ${columns} FROM ${table}
          WHERE place_id = $merge
        `).run({ $keep: keepId, $merge: mergeId });
      }
      this.addAliases(keepId, [merge.canonical_name]);
      this.db.query(`UPDATE media SET place_id = $keep WHERE place_id = $merge`).run({ $keep: keepId, $merge: mergeId });
      this.db.query(`UPDATE activities SET place_id = $keep WHERE place_id = $merge`).run({ $keep: keepId, $merge: mergeId });
      this.db.query(`
        INSERT OR IGNORE INTO external_mappings (system, place_id, external_id, last_verified_at)
        SELECT system, $keep, external_id, last_verified_at
        FROM external_mappings WHERE place_id = $merge
      `).run({ $keep: keepId, $merge: mergeId });
      this.db.query(`DELETE FROM external_mappings WHERE place_id = $merge`).run({ $merge: mergeId });
      this.db.query(`DELETE FROM member_place_state WHERE place_id IN ($keep, $merge)`).run({ $keep: keepId, $merge: mergeId });
      const members = this.db.query(`SELECT DISTINCT member_id FROM activities WHERE place_id = $place`).all({ $place: keepId }) as { member_id: string }[];
      for (const row of members) this.projectMemberState(keepId, row.member_id);
      this.db.query(`
        UPDATE places SET status = 'merged', merged_into = $keep, updated_at = $at WHERE id = $merge
      `).run({ $keep: keepId, $merge: mergeId, $at: at });
      const memberId = this.upsertMember(member, at);
      this.addActivity(keepId, memberId, undefined, { type: 'merged', comment: reason, visibility: 'group' }, undefined, at);
      this.db.query(`UPDATE places SET updated_at = $at WHERE id = $keep`).run({ $at: at, $keep: keepId });
      return this.bumpRevision();
    });
    const revision = transaction();
    return {
      ok: true,
      placeId: keepId,
      revision,
      affectedRegions: [...new Set([keep.region_id, merge.region_id].filter((value): value is string => Boolean(value)))],
    };
  }

  listPlaces(options: {
    regionId?: string;
    category?: string;
    interest?: InterestState;
    visitState?: VisitState;
    includeClosed?: boolean;
    profile?: 'private' | 'share';
  } = {}): PlaceView[] {
    const profile = options.profile ?? 'private';
    const clauses = [options.includeClosed ? `p.status != 'merged'` : `p.status = 'active'`];
    const params: Record<string, string> = {};
    if (options.regionId) {
      clauses.push('p.region_id = $region');
      params.$region = slugify(options.regionId);
    }
    const rows = this.db.query(`
      SELECT p.*, r.name AS region_name
      FROM places p LEFT JOIN regions r ON r.id = p.region_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.updated_at DESC, p.canonical_name
    `).all(params) as Array<PlaceRow & { region_name: string | null }>;
    let views = rows.map((row) => this.placeFromRow(row, profile));
    if (options.category) views = views.filter((place) => place.categories.includes(options.category!));
    if (options.interest) views = views.filter((place) => place.memberStates.some((state) => state.interest === options.interest));
    if (options.visitState) views = views.filter((place) => place.memberStates.some((state) => state.visitState === options.visitState));
    return views;
  }

  search(query: string, options: Parameters<PlaceStore['listPlaces']>[0] = {}): PlaceView[] {
    const normalized = normalizeText(query);
    if (!normalized) return this.listPlaces(options);
    const terms = normalized.split(' ');
    return this.listPlaces(options).filter((place) => {
      const haystack = normalizeText(JSON.stringify({
        name: place.name,
        aliases: place.aliases,
        address: place.address,
        locality: place.locality,
        neighborhood: place.neighborhood,
        categories: place.categories,
        tags: place.tags,
        evidence: place.evidence.map((item) => item.reference),
        comments: place.activities.map((activity) => activity.comment),
      }));
      return terms.every((term) => haystack.includes(term));
    });
  }

  showPlace(placeId: string, profile: 'private' | 'share' = 'private'): PlaceView {
    const row = this.db.query(`
      SELECT p.*, r.name AS region_name
      FROM places p LEFT JOIN regions r ON r.id = p.region_id
      WHERE p.id = $id
    `).get({ $id: placeId }) as (PlaceRow & { region_name: string | null }) | null;
    if (!row) throw new Error(`place not found: ${placeId}`);
    return this.placeFromRow(row, profile);
  }

  private placeFromRow(row: PlaceRow & { region_name: string | null }, profile: 'private' | 'share'): PlaceView {
    const aliases = (this.db.query(`
      SELECT alias FROM place_aliases WHERE place_id = $place ORDER BY alias
    `).all({ $place: row.id }) as { alias: string }[]).map((item) => item.alias);
    const categories = (this.db.query(`
      SELECT c.id FROM place_categories pc JOIN categories c ON c.id = pc.category_id
      WHERE pc.place_id = $place ORDER BY c.sort_order
    `).all({ $place: row.id }) as { id: string }[]).map((item) => item.id);
    const tags = (this.db.query(`
      SELECT tag FROM place_tags WHERE place_id = $place ORDER BY tag
    `).all({ $place: row.id }) as { tag: string }[]).map((item) => item.tag);
    const sources = this.db.query(`
      SELECT s.id, s.url, s.platform, s.title, s.author
      FROM place_sources ps JOIN sources s ON s.id = ps.source_id
      WHERE ps.place_id = $place AND s.url IS NOT NULL
      ORDER BY s.shared_at DESC, s.created_at DESC
    `).all({ $place: row.id }) as PlaceSourceView[];
    const evidenceRows = this.db.query(`
      SELECT id, reference, role
      FROM place_evidence WHERE place_id = $place ORDER BY created_at, id
    `).all({ $place: row.id }) as Array<{ id: string; reference: string; role: 'verification' }>;
    const evidence: PlaceEvidenceView[] = evidenceRows.map((item) => ({
      id: item.id,
      reference: item.reference,
      role: item.role,
      ...(item.reference.match(/^https?:\/\//i) ? { url: item.reference } : {}),
    }));
    const visibilitySql = profile === 'share' ? `AND visibility = 'shareable'` : '';
    const mediaRows = this.db.query(`
      SELECT id, kind, url, local_path, alt, attribution, visibility
      FROM media WHERE place_id = $place ${visibilitySql} ORDER BY created_at
    `).all({ $place: row.id }) as Array<{
      id: string; kind: string; url: string | null; local_path: string | null;
      alt: string; attribution: string | null; visibility: Visibility;
    }>;
    const media: PlaceMediaView[] = mediaRows.map((item) => ({
      id: item.id,
      kind: item.kind,
      ...(item.url ? { url: item.url } : {}),
      ...(item.local_path ? { localPath: item.local_path } : {}),
      alt: item.alt,
      ...(item.attribution ? { attribution: item.attribution } : {}),
      visibility: item.visibility,
    }));
    const privateStateRows = this.db.query(`
      SELECT mps.*, m.display_alias
      FROM member_place_state mps JOIN members m ON m.id = mps.member_id
      WHERE mps.place_id = $place ORDER BY m.display_alias
    `).all({ $place: row.id }) as Array<{
      member_id: string; display_alias: string; interest: InterestState | null;
      visit_state: VisitState; rating: number | null; last_comment: string | null; updated_at: string;
    }>;
    const activityRows = this.db.query(`
      SELECT a.*, m.display_alias
      FROM activities a JOIN members m ON m.id = a.member_id
      WHERE a.place_id = $place ${profile === 'share' ? `AND a.visibility = 'shareable'` : ''}
      ORDER BY a.occurred_at DESC, a.recorded_at DESC
    `).all({ $place: row.id }) as Array<{
      id: string; member_id: string; type: string; display_alias: string; interest: InterestState | null;
      visit_state: VisitState | null; rating: number | null; body: string | null;
      visibility: Visibility; occurred_at: string; recorded_at: string;
    }>;
    const shareStates = new Map<string, {
      member_id: string; display_alias: string; interest: InterestState | null;
      visit_state: VisitState; rating: number | null; last_comment: string | null; updated_at: string;
    }>();
    for (const activity of [...activityRows].reverse()) {
      const state = shareStates.get(activity.member_id) ?? {
        member_id: activity.member_id,
        display_alias: activity.display_alias,
        interest: null,
        visit_state: 'not-visited' as VisitState,
        rating: null,
        last_comment: null,
        updated_at: activity.recorded_at,
      };
      if (activity.interest != null) state.interest = activity.interest;
      if (activity.visit_state != null) state.visit_state = activity.visit_state;
      if (activity.rating != null) state.rating = activity.rating;
      if (activity.body != null) state.last_comment = activity.body;
      state.updated_at = activity.recorded_at;
      shareStates.set(activity.member_id, state);
    }
    const stateRows = profile === 'share'
      ? [...shareStates.values()]
      : privateStateRows;
    const memberStates: MemberPlaceStateView[] = stateRows.map((item) => ({
      memberId: profile === 'share' ? sha256(item.member_id).slice(0, 12) : item.member_id,
      displayAlias: profile === 'share' ? 'A member' : item.display_alias,
      ...(item.interest ? { interest: item.interest } : {}),
      visitState: item.visit_state,
      ...(item.rating != null ? { rating: item.rating } : {}),
      ...(item.last_comment ? { lastComment: item.last_comment } : {}),
      updatedAt: item.updated_at,
    }));
    const activities: ActivityView[] = activityRows.map((item) => ({
      id: item.id,
      type: item.type,
      displayAlias: profile === 'share' ? 'A member' : item.display_alias,
      ...(item.interest ? { interest: item.interest } : {}),
      ...(item.visit_state ? { visitState: item.visit_state } : {}),
      ...(item.rating != null ? { rating: item.rating } : {}),
      ...(item.body ? { comment: item.body } : {}),
      visibility: item.visibility,
      occurredAt: item.occurred_at,
    }));
    const ratings = stateRows.map((item) => item.rating).filter((value): value is number => value != null);
    return {
      id: row.id,
      anchor: `place-${row.slug}-${row.id.slice(-6)}`,
      name: row.canonical_name,
      aliases,
      ...(row.region_id ? { regionId: row.region_id } : {}),
      ...(row.region_name ? { regionName: row.region_name } : {}),
      ...(row.address ? { address: row.address } : {}),
      ...(row.locality ? { locality: row.locality } : {}),
      ...(row.neighborhood ? { neighborhood: row.neighborhood } : {}),
      ...(row.lat != null && row.lng != null ? { coordinates: { lat: row.lat, lng: row.lng } } : {}),
      status: row.status,
      verificationState: row.verification_state,
      confidence: row.confidence,
      categories,
      tags,
      sources,
      evidence,
      media,
      memberStates,
      activities,
      summary: {
        wantToGo: stateRows.filter((item) => item.interest === 'want-to-go').length,
        visited: stateRows.filter((item) => item.visit_state === 'visited').length,
        revisit: stateRows.filter((item) => item.visit_state === 'revisit').length,
        notForMe: stateRows.filter((item) => item.interest === 'not-for-me').length,
        ...(ratings.length ? { ratingAverage: Math.round((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 10) / 10 } : {}),
        ratingCount: ratings.length,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  doctor(): {
    ok: boolean;
    schemaVersion: number;
    revision: number;
    regions: number;
    places: number;
    openReviews: number;
    foreignKeyErrors: unknown[];
  } {
    const foreignKeyErrors = this.db.query(`PRAGMA foreign_key_check`).all();
    const count = (table: string, where = '') =>
      Number((this.db.query(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as { count: number }).count);
    return {
      ok: foreignKeyErrors.length === 0 && this.schemaVersion() === SCHEMA_VERSION,
      schemaVersion: this.schemaVersion(),
      revision: this.revision(),
      regions: count('regions', 'WHERE active = 1'),
      places: count('places', `WHERE status != 'merged'`),
      openReviews: count('review_items', `WHERE status = 'open'`),
      foreignKeyErrors,
    };
  }
}
