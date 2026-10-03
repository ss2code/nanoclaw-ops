/**
 * Memory reader — the single source of truth for the unified memory engine
 * (commit eef2b78). One per-DB reader (`readMemoryDb`) is reused by both the
 * Memory tab (all groups, via `readAllGroupMemories`) and the Trip Companion tab
 * (per trip, via `readers/trips.ts`). Observability is read from the engine's
 * `memory_events` table — never the retired `memory.log`.
 *
 * Data volume is tiny (tens of rows per group), so each DB is read in full and
 * facets/filters are applied in JS rather than per-DB SQL.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { PATHS } from '../config.js';
import type { AgentGroupInfo } from './central.js';

export interface MemoryRow {
  id: number;
  scope: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  source: string | null;
  importance: number;
  status: string;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  /** Present on the all-groups view; the group this row belongs to. */
  group?: { id: string; name: string; folder: string };
}

/** Per-DB snapshot. Shape is consumed by readers/trips.ts as `snapshot.memory`. */
export interface MemoryDbSnapshot {
  available: boolean;
  error: string | null;
  total: number;
  active: number;
  pending: number;
  rejected: number;
  owner: string | null;
  lastUpdated: string | null;
  dbSizeBytes: number;
  rows: MemoryRow[];
}

export interface MemoryGroupSummary {
  id: string;
  name: string;
  folder: string;
  available: boolean;
  error: string | null;
  total: number;
  active: number;
  pending: number;
}

export interface AllGroupMemories {
  /** Filtered, group-tagged, sorted, limited rows for display. */
  rows: MemoryRow[];
  /** How many rows matched before the display limit. */
  shown: number;
  /** Per-group facet + counts (drives the group dropdown and totals). */
  groups: MemoryGroupSummary[];
  /** Distinct scopes across all groups (drives the scope dropdown). */
  scopes: string[];
  /** Distinct categories with counts (drives the category dropdown). */
  categories: { category: string; count: number }[];
  groupsWithMemory: number;
  totalMemories: number;
  totalPending: number;
  /** memory.db paths actually read — pass to the events readers. */
  dbPaths: string[];
}

export interface MemoryEventsStats {
  available: boolean;
  totalEvents: number;
  recalls: number;
  hitRate: number | null;
  emptyRecallRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  writes: number;
  approvals: number;
  rejects: number;
  dedupCollisions: number;
  byOp: { op: string; count: number }[];
  lastEventAt: string | null;
}

export interface MemoryEventRow {
  at: string;
  op: string;
  scope: string | null;
  query: string | null;
  hitCount: number | null;
  latencyMs: number | null;
  actor: string | null;
  /** Compact per-result score trace parsed from score_json, if present. */
  scoreTrace: string | null;
}

interface RawMemoryRow {
  id: number;
  scope?: string | null;
  category?: string | null;
  title?: string | null;
  content?: string | null;
  tags?: string | null;
  source?: string | null;
  importance?: number | null;
  status?: string | null;
  access_count?: number | null;
  last_accessed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  expires_at?: string | null;
}

function openReadonly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');
  return db;
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

function columnSet(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name));
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Nearest-rank percentile over an unsorted numeric array. Null when empty. */
function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

function mapRow(r: RawMemoryRow): MemoryRow {
  return {
    id: Number(r.id),
    scope: r.scope ?? 'group:default',
    category: r.category ?? 'note',
    title: r.title ?? '',
    content: r.content ?? '',
    tags: parseTags(r.tags),
    source: r.source ?? null,
    importance: Number(r.importance ?? 0),
    status: r.status ?? 'active',
    accessCount: Number(r.access_count ?? 0),
    lastAccessedAt: r.last_accessed_at ?? null,
    createdAt: r.created_at ?? '',
    updatedAt: r.updated_at ?? '',
    expiresAt: r.expires_at ?? null,
  };
}

const EMPTY_DB_SNAPSHOT: MemoryDbSnapshot = {
  available: false,
  error: null,
  total: 0,
  active: 0,
  pending: 0,
  rejected: 0,
  owner: null,
  lastUpdated: null,
  dbSizeBytes: 0,
  rows: [],
};

/**
 * Read one memory.db (read-only, no migration). Tolerates both the unified
 * schema and pre-migration legacy DBs (missing scope/status default to
 * group:default/active). Returns all statuses; callers filter as needed.
 */
export function readMemoryDb(dbPath: string, limit = 250): MemoryDbSnapshot {
  if (!fs.existsSync(dbPath)) return { ...EMPTY_DB_SNAPSHOT };
  let db: Database.Database | null = null;
  try {
    db = openReadonly(dbPath);
    if (!tableExists(db, 'memories')) {
      return { ...EMPTY_DB_SNAPSHOT, available: true, error: 'memories table missing' };
    }
    const cols = columnSet(db, 'memories');
    const hasStatus = cols.has('status');

    // Newest-first, so the `limit` cap drops the oldest rows rather than the
    // least important ones. Legacy DBs may predate created_at.
    const order = cols.has('created_at') ? 'COALESCE(created_at, updated_at) DESC, id DESC' : 'updated_at DESC, id DESC';
    const rows = (db.prepare(`SELECT * FROM memories ORDER BY ${order} LIMIT ?`).all(limit) as RawMemoryRow[]).map(mapRow);

    const byStatus = hasStatus
      ? Object.fromEntries(
          (db.prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status').all() as { status: string; n: number }[]).map((r) => [
            r.status,
            Number(r.n),
          ]),
        )
      : {};
    const total = Number((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n);
    const active = hasStatus ? (byStatus.active ?? 0) : total;
    const owner =
      tableExists(db, 'meta') && (db.prepare("SELECT v FROM meta WHERE k = 'owner_id'").get() as { v: string } | undefined)
        ? (db.prepare("SELECT v FROM meta WHERE k = 'owner_id'").get() as { v: string }).v
        : null;
    const lastUpdated =
      (db.prepare('SELECT MAX(updated_at) AS u FROM memories').get() as { u: string | null }).u ?? null;

    return {
      available: true,
      error: null,
      total,
      active,
      pending: hasStatus ? (byStatus.pending ?? 0) : 0,
      rejected: hasStatus ? (byStatus.rejected ?? 0) : 0,
      owner,
      lastUpdated,
      dbSizeBytes: fs.statSync(dbPath).size,
      rows,
    };
  } catch (error) {
    return { ...EMPTY_DB_SNAPSHOT, available: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/** Table orderings offered by the Knowledge sort dropdown. `newest` is the default. */
export const MEMORY_SORTS = {
  newest: 'newest first',
  oldest: 'oldest first',
  updated: 'recently updated',
  importance: 'importance',
  recalls: 'most recalled',
} as const;

export type MemorySort = keyof typeof MEMORY_SORTS;

export function isMemorySort(v: string): v is MemorySort {
  return v in MEMORY_SORTS;
}

const added = (r: MemoryRow) => r.createdAt || r.updatedAt;

// Every comparator falls back to added-desc so ties stay LIFO rather than
// landing in whatever order the groups happened to be read in.
const MEMORY_COMPARATORS: Record<MemorySort, (a: MemoryRow, b: MemoryRow) => number> = {
  newest: (a, b) => added(b).localeCompare(added(a)),
  oldest: (a, b) => added(a).localeCompare(added(b)),
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || added(b).localeCompare(added(a)),
  importance: (a, b) => b.importance - a.importance || added(b).localeCompare(added(a)),
  recalls: (a, b) => b.accessCount - a.accessCount || added(b).localeCompare(added(a)),
};

/**
 * Read memory across every agent group that has a memory.db, tag each row with
 * its group, build the filter facets, and apply the requested filters in JS.
 */
export function readAllGroupMemories(
  groups: AgentGroupInfo[],
  opts: {
    group?: string;
    scope?: string;
    status?: string;
    category?: string;
    tag?: string;
    q?: string;
    sort?: MemorySort;
    limit?: number;
    groupsDir?: string;
  } = {},
): AllGroupMemories {
  const groupsDir = opts.groupsDir ?? PATHS.groupsDir;
  const groupSummaries: MemoryGroupSummary[] = [];
  const allRows: MemoryRow[] = [];
  const dbPaths: string[] = [];

  for (const g of groups) {
    const file = path.join(groupsDir, g.folder, 'memory.db');
    if (!fs.existsSync(file)) continue;
    dbPaths.push(file);
    const snap = readMemoryDb(file);
    groupSummaries.push({
      id: g.id,
      name: g.name,
      folder: g.folder,
      available: snap.available,
      error: snap.error,
      total: snap.total,
      active: snap.active,
      pending: snap.pending,
    });
    for (const row of snap.rows) {
      row.group = { id: g.id, name: g.name, folder: g.folder };
      allRows.push(row);
    }
  }

  const scopes = [...new Set(allRows.map((r) => r.scope))].sort();
  const catCounts = new Map<string, number>();
  for (const r of allRows) catCounts.set(r.category, (catCounts.get(r.category) ?? 0) + 1);
  const categories = [...catCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  const status = opts.status || 'active';
  const q = opts.q?.trim().toLowerCase();
  const filtered = allRows
    .filter((r) => (status === 'all' ? true : r.status === status))
    .filter((r) => (opts.group ? r.group?.id === opts.group : true))
    .filter((r) => (opts.scope ? r.scope === opts.scope : true))
    .filter((r) => (opts.category ? r.category === opts.category : true))
    .filter((r) => (opts.tag ? r.tags.includes(opts.tag) : true))
    .filter((r) => {
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.content.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q))
      );
    })
    // Default is LIFO: most recently added first. Sorting by importance (the old
    // default) hid fresh low-star rows behind old five-star ones, which read as
    // "my write is missing".
    .sort(MEMORY_COMPARATORS[opts.sort && opts.sort in MEMORY_COMPARATORS ? opts.sort : 'newest']);

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  return {
    rows: filtered.slice(0, limit),
    shown: filtered.length,
    groups: groupSummaries,
    scopes,
    categories,
    groupsWithMemory: groupSummaries.filter((g) => g.available).length,
    totalMemories: groupSummaries.reduce((sum, g) => sum + g.total, 0),
    totalPending: groupSummaries.reduce((sum, g) => sum + g.pending, 0),
    dbPaths,
  };
}

interface RawEvent {
  at: string;
  op: string;
  scope: string | null;
  query: string | null;
  hit_count: number | null;
  latency_ms: number | null;
  score_json: string | null;
  actor: string | null;
  detail_json: string | null;
}

function readRawEvents(dbPaths: string[]): RawEvent[] {
  const events: RawEvent[] = [];
  for (const file of dbPaths) {
    if (!fs.existsSync(file)) continue;
    let db: Database.Database | null = null;
    try {
      db = openReadonly(file);
      if (!tableExists(db, 'memory_events')) continue;
      events.push(
        ...(db
          .prepare(
            'SELECT at, op, scope, query, hit_count, latency_ms, score_json, actor, detail_json FROM memory_events ORDER BY at DESC LIMIT 1000',
          )
          .all() as RawEvent[]),
      );
    } catch {
      // A group's events table may be mid-write or absent; others still count.
    } finally {
      db?.close();
    }
  }
  return events;
}

/** Aggregate observability over the engine's memory_events across groups. */
export function readMemoryEventsStats(dbPaths: string[]): MemoryEventsStats {
  const events = readRawEvents(dbPaths);
  if (!events.length) {
    return {
      available: false,
      totalEvents: 0,
      recalls: 0,
      hitRate: null,
      emptyRecallRate: null,
      p50Ms: null,
      p95Ms: null,
      writes: 0,
      approvals: 0,
      rejects: 0,
      dedupCollisions: 0,
      byOp: [],
      lastEventAt: null,
    };
  }

  const recalls = events.filter((e) => e.op === 'recall');
  const recallHits = recalls.filter((e) => (e.hit_count ?? 0) > 0).length;
  const latencies = recalls.map((e) => Number(e.latency_ms)).filter((n) => Number.isFinite(n));
  const dedupCollisions = events.filter((e) => {
    if (e.op !== 'remember' || !e.detail_json) return false;
    try {
      return JSON.parse(e.detail_json)?.duplicate === true;
    } catch {
      return false;
    }
  }).length;

  const opCounts = new Map<string, number>();
  for (const e of events) opCounts.set(e.op, (opCounts.get(e.op) ?? 0) + 1);

  return {
    available: true,
    totalEvents: events.length,
    recalls: recalls.length,
    hitRate: recalls.length ? recallHits / recalls.length : null,
    emptyRecallRate: recalls.length ? (recalls.length - recallHits) / recalls.length : null,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    writes: opCounts.get('remember') ?? 0,
    approvals: opCounts.get('approve') ?? 0,
    rejects: opCounts.get('reject') ?? 0,
    dedupCollisions,
    byOp: [...opCounts.entries()].map(([op, count]) => ({ op, count })).sort((a, b) => b.count - a.count),
    lastEventAt: events.reduce((max, e) => (e.at > max ? e.at : max), events[0].at),
  };
}

/** Compress score_json into a short "id:score" trace for the recall events table. */
function scoreTraceOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null;
    if (!arr) return null;
    return arr
      .slice(0, 5)
      .map((r: { id?: unknown; score?: unknown }) => {
        const id = r?.id != null ? `#${r.id}` : '?';
        const score = typeof r?.score === 'number' ? r.score.toFixed(2) : null;
        return score ? `${id}:${score}` : id;
      })
      .join(' · ');
  } catch {
    return null;
  }
}

/** Most-recent events across groups, newest first, with a compact score trace. */
export function readRecentMemoryEvents(dbPaths: string[], limit = 40): MemoryEventRow[] {
  return readRawEvents(dbPaths)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((e) => ({
      at: e.at,
      op: e.op,
      scope: e.scope,
      query: e.query,
      hitCount: e.hit_count,
      latencyMs: e.latency_ms,
      actor: e.actor,
      scoreTrace: scoreTraceOf(e.score_json),
    }));
}

// ----------------------------------------------------- per-group observability (Phase 4)

export interface GroupDbPath {
  group: { id: string; name: string; folder: string };
  dbPath: string;
}

/** {group, dbPath}[] for every agent group that has a memory.db — threads group identity into the events readers. */
export function groupDbPaths(groups: AgentGroupInfo[], groupsDir?: string): GroupDbPath[] {
  const dir = groupsDir ?? PATHS.groupsDir;
  const out: GroupDbPath[] = [];
  for (const g of groups) {
    const dbPath = path.join(dir, g.folder, 'memory.db');
    if (fs.existsSync(dbPath)) out.push({ group: { id: g.id, name: g.name, folder: g.folder }, dbPath });
  }
  return out;
}

export interface PerGroupMemoryStats {
  group: { id: string; name: string; folder: string };
  rows: number;
  recalls: number;
  hitRate: number | null;
  emptyRecalls: number;
  /** % of active rows with access_count > 0 — recall reinforcement coverage (finding #8). */
  reinforcementCoverage: number | null;
}

/** Per-group memory stats, incl. reinforcement coverage — exposes the flagship's 0% anomaly. */
export function readPerGroupMemoryStats(entries: GroupDbPath[]): PerGroupMemoryStats[] {
  return entries.map(({ group, dbPath }) => {
    const snap = readMemoryDb(dbPath, 1000);
    const active = snap.rows.filter((r) => r.status === 'active');
    const reinforced = active.filter((r) => r.accessCount > 0).length;
    const stats = readMemoryEventsStats([dbPath]);
    return {
      group,
      rows: snap.total,
      recalls: stats.recalls,
      hitRate: stats.hitRate,
      emptyRecalls: stats.hitRate == null ? 0 : Math.round(stats.recalls * (stats.emptyRecallRate ?? 0)),
      reinforcementCoverage: active.length ? reinforced / active.length : null,
    };
  });
}

export interface EmptyRecall {
  query: string;
  count: number;
  lastAt: string;
  groups: string[];
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Empty-recall mining (finding #8): recalls that matched nothing (hit_count = 0)
 * in the last N days, deduped by normalized query — "what agents looked for and
 * didn't find." The single best signal for what's missing from each memory.
 */
export function readEmptyRecalls(entries: GroupDbPath[], opts: { days?: number; limit?: number } = {}): EmptyRecall[] {
  const cutoff = new Date(Date.now() - (opts.days ?? 30) * 86_400_000).toISOString();
  const byQuery = new Map<string, { query: string; count: number; lastAt: string; groups: Set<string> }>();
  for (const { group, dbPath } of entries) {
    if (!fs.existsSync(dbPath)) continue;
    let db: Database.Database | null = null;
    try {
      db = openReadonly(dbPath);
      if (!tableExists(db, 'memory_events')) continue;
      const rows = db
        .prepare(
          "SELECT query, at FROM memory_events WHERE op = 'recall' AND (hit_count = 0 OR hit_count IS NULL) AND query IS NOT NULL AND at >= ? ORDER BY at DESC LIMIT 500",
        )
        .all(cutoff) as { query: string; at: string }[];
      for (const r of rows) {
        const key = normalizeQuery(r.query);
        if (!key) continue;
        const e = byQuery.get(key);
        if (e) {
          e.count++;
          e.groups.add(group.name);
          if (r.at > e.lastAt) e.lastAt = r.at;
        } else {
          byQuery.set(key, { query: r.query, count: 1, lastAt: r.at, groups: new Set([group.name]) });
        }
      }
    } catch {
      // mid-write / missing table — other groups still count.
    } finally {
      db?.close();
    }
  }
  return [...byQuery.values()]
    .map((e) => ({ query: e.query, count: e.count, lastAt: e.lastAt, groups: [...e.groups].sort() }))
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
    .slice(0, opts.limit ?? 40);
}
