/**
 * ops.db — the only file the Ops Center writes. Raw 1-minute samples,
 * hourly/daily rollups, discrete events, and a small meta KV.
 * Retention ladder: raw 48h → hourly 90d → daily 1y (see design §4).
 */
import Database from 'better-sqlite3';

export interface Sample {
  ts: string; // ISO minute
  group_id: string; // agent group id or 'all' / 'host'
  metric: string; // e.g. msgs_in, tokens_out.claude-sonnet-4-6, queue_depth
  value: number;
}

export type MissionHealthState = 'ok' | 'warn' | 'critical' | 'stale' | 'unavailable';

/** Low-cost summary of the latest collector view of NanoClaw work. */
export interface MissionHealth {
  state: MissionHealthState;
  sampleAgeMs: number | null;
  queueDepth: number | null;
  inflight: number | null;
  unanswered: number | null;
  /** Max reply latency observed in the latest sample minute, when any existed. */
  latencyMsMax: number | null;
}

export interface OpsEvent {
  ts: string;
  group_id: string;
  kind: string;
  severity: 'info' | 'warn' | 'error';
  detail: string;
}

export interface IncidentRow {
  id: string;
  scope_key: string;
  group_id: string | null;
  status: 'open' | 'resolved';
  severity: 'warn' | 'error';
  title: string;
  summary: string;
  evidence_json: string;
  recommendation: string;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface OperationRow {
  id: string;
  kind: string;
  scope_type: 'host' | 'group' | 'system';
  scope_id: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'unverified' | 'rolled_back';
  started_at: string;
  finished_at: string | null;
  before_json: string;
  after_json: string | null;
  result: string | null;
  rollback_json: string | null;
}

export function openOpsDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      ts TEXT NOT NULL, group_id TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
    CREATE INDEX IF NOT EXISTS idx_samples_gm ON samples(group_id, metric, ts);
    CREATE TABLE IF NOT EXISTS rollup_hourly (
      hour TEXT NOT NULL, group_id TEXT NOT NULL, metric TEXT NOT NULL,
      sum REAL, avg REAL, min REAL, max REAL, count INTEGER,
      PRIMARY KEY (hour, group_id, metric)
    );
    CREATE TABLE IF NOT EXISTS rollup_daily (
      day TEXT NOT NULL, group_id TEXT NOT NULL, metric TEXT NOT NULL,
      sum REAL, avg REAL, min REAL, max REAL, count INTEGER,
      PRIMARY KEY (day, group_id, metric)
    );
    CREATE TABLE IF NOT EXISTS events (
      ts TEXT NOT NULL, group_id TEXT NOT NULL, kind TEXT NOT NULL,
      severity TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      group_id TEXT,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_incidents_scope ON incidents(scope_key, status);
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      before_json TEXT NOT NULL,
      after_json TEXT,
      result TEXT,
      rollback_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operations_started ON operations(started_at);
    CREATE TABLE IF NOT EXISTS config_snapshots (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      group_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      config_json TEXT NOT NULL,
      operation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_config_snapshots_group ON config_snapshots(group_id, ts);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

export function insertSamples(db: Database.Database, samples: Sample[]): void {
  if (!samples.length) return;
  const stmt = db.prepare('INSERT INTO samples (ts, group_id, metric, value) VALUES (?, ?, ?, ?)');
  const tx = db.transaction((rows: Sample[]) => {
    for (const s of rows) stmt.run(s.ts, s.group_id, s.metric, s.value);
  });
  tx(samples);
}

export function addEvent(db: Database.Database, ev: OpsEvent): void {
  db.prepare('INSERT INTO events (ts, group_id, kind, severity, detail) VALUES (?, ?, ?, ?, ?)').run(
    ev.ts,
    ev.group_id,
    ev.kind,
    ev.severity,
    ev.detail,
  );
}

export interface EventRow {
  ts: string;
  group_id: string;
  kind: string;
  severity: string;
  detail: string;
}

export function listEventsByKind(
  db: Database.Database,
  groupId: string,
  kinds: string[],
  sinceIso: string,
  limit = 2000,
): EventRow[] {
  if (!kinds.length) return [];
  const ph = kinds.map(() => '?').join(',');
  return db
    .prepare(`SELECT ts, group_id, kind, severity, detail FROM events
      WHERE group_id = ? AND kind IN (${ph}) AND ts >= ? ORDER BY ts LIMIT ?`)
    .all(groupId, ...kinds, sinceIso, limit) as EventRow[];
}

/** Newest sample ts where the group had a container up — used to approx-close orphaned spans. */
export function lastActiveSampleMs(db: Database.Database, groupId: string, sinceIso: string): number | null {
  const row = db
    .prepare(
      "SELECT MAX(ts) AS t FROM samples WHERE group_id = ? AND metric = 'containers_up' AND value > 0 AND ts >= ?",
    )
    .get(groupId, sinceIso) as { t: string | null };
  return row.t ? Date.parse(row.t) : null;
}

export function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

/**
 * Read the latest low-cost mission signals without opening session databases.
 *
 * The collector intentionally omits zero-valued samples to keep ops.db small.
 * `last_sample` is therefore the tick boundary: a metric whose newest row is
 * older than that boundary was zero in the latest tick, not still at its old
 * non-zero value. This keeps the System card honest while adding only one small
 * indexed read per uncached status refresh.
 */
export function readMissionHealth(db: Database.Database, nowMs = Date.now()): MissionHealth {
  const lastSampleIso = getMeta(db, 'last_sample');
  const lastSampleMs = lastSampleIso ? Date.parse(lastSampleIso) : NaN;
  if (!Number.isFinite(lastSampleMs)) {
    return {
      state: 'unavailable',
      sampleAgeMs: null,
      queueDepth: null,
      inflight: null,
      unanswered: null,
      latencyMsMax: null,
    };
  }

  const rows = db
    .prepare(
      `SELECT metric, value, ts FROM samples
       WHERE group_id = 'all' AND metric IN ('queue_depth', 'inflight', 'unanswered', 'latency_ms_max')
       ORDER BY ts DESC LIMIT 100`,
    )
    .all() as { metric: string; value: number; ts: string }[];
  const latest = new Map<string, { value: number; tsMs: number }>();
  for (const row of rows) {
    if (latest.has(row.metric)) continue;
    const tsMs = Date.parse(row.ts);
    if (Number.isFinite(tsMs)) latest.set(row.metric, { value: row.value, tsMs });
  }

  const currentValue = (metric: string): number => {
    const row = latest.get(metric);
    return row && row.tsMs >= lastSampleMs ? row.value : 0;
  };
  const currentLatency = (): number | null => {
    const row = latest.get('latency_ms_max');
    return row && row.tsMs >= lastSampleMs ? row.value : null;
  };
  const sampleAgeMs = Math.max(0, nowMs - lastSampleMs);
  const queueDepth = currentValue('queue_depth');
  const inflight = currentValue('inflight');
  const unanswered = currentValue('unanswered');
  const latencyMsMax = currentLatency();

  let state: MissionHealthState = 'ok';
  if (sampleAgeMs > 180_000) state = 'stale';
  else if (unanswered > 0 || (latencyMsMax ?? 0) >= 120_000) state = 'critical';
  else if (queueDepth > 0 || (latencyMsMax ?? 0) >= 30_000) state = 'warn';

  return { state, sampleAgeMs, queueDepth, inflight, unanswered, latencyMsMax };
}

export function listIncidents(db: Database.Database, status?: 'open' | 'resolved', limit = 100): IncidentRow[] {
  const sql = status
    ? 'SELECT * FROM incidents WHERE status = ? ORDER BY updated_at DESC LIMIT ?'
    : 'SELECT * FROM incidents ORDER BY updated_at DESC LIMIT ?';
  return (status ? db.prepare(sql).all(status, limit) : db.prepare(sql).all(limit)) as IncidentRow[];
}

export function listOperations(db: Database.Database, limit = 100): OperationRow[] {
  return db.prepare('SELECT * FROM operations ORDER BY started_at DESC LIMIT ?').all(limit) as OperationRow[];
}

/** Aggregate completed hours of raw samples into rollup_hourly (idempotent upsert). */
export function rollupHourly(db: Database.Database, now: Date): void {
  const currentHour = now.toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
  db.prepare(
    `INSERT INTO rollup_hourly (hour, group_id, metric, sum, avg, min, max, count)
     SELECT substr(ts, 1, 13), group_id, metric, SUM(value), AVG(value), MIN(value), MAX(value), COUNT(*)
     FROM samples WHERE substr(ts, 1, 13) < ?
     GROUP BY substr(ts, 1, 13), group_id, metric
     ON CONFLICT(hour, group_id, metric) DO UPDATE SET
       sum = excluded.sum, avg = excluded.avg, min = excluded.min, max = excluded.max, count = excluded.count`,
  ).run(currentHour);
}

/** Aggregate completed days of hourly rollups into rollup_daily. */
export function rollupDaily(db: Database.Database, now: Date): void {
  const currentDay = now.toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO rollup_daily (day, group_id, metric, sum, avg, min, max, count)
     SELECT substr(hour, 1, 10), group_id, metric, SUM(sum), AVG(avg), MIN(min), MAX(max), SUM(count)
     FROM rollup_hourly WHERE substr(hour, 1, 10) < ?
     GROUP BY substr(hour, 1, 10), group_id, metric
     ON CONFLICT(day, group_id, metric) DO UPDATE SET
       sum = excluded.sum, avg = excluded.avg, min = excluded.min, max = excluded.max, count = excluded.count`,
  ).run(currentDay);
}

export function prune(
  db: Database.Database,
  now: Date,
  retention: { rawHours: number; hourlyDays: number; dailyDays: number; eventDays: number },
): void {
  const cutoff = (ms: number) => new Date(now.getTime() - ms).toISOString();
  db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff(retention.rawHours * 3_600_000));
  db.prepare('DELETE FROM rollup_hourly WHERE hour < ?').run(cutoff(retention.hourlyDays * 86_400_000).slice(0, 13));
  db.prepare('DELETE FROM rollup_daily WHERE day < ?').run(cutoff(retention.dailyDays * 86_400_000).slice(0, 10));
  db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff(retention.eventDays * 86_400_000));
}

export interface SeriesPoint {
  t: string;
  value: number;
}

/**
 * Time series for charts. Picks the source by range: raw (<=48h), hourly (<=90d), daily (rest).
 * `agg` chooses which rollup column to read ('sum' for counters, 'avg'/'max' for gauges).
 */
export function getSeries(
  db: Database.Database,
  groupId: string,
  metric: string,
  fromIso: string,
  toIso: string,
  agg: 'sum' | 'avg' | 'max' = 'sum',
): SeriesPoint[] {
  const spanMs = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (spanMs <= 48 * 3_600_000) {
    return db
      .prepare(
        'SELECT ts AS t, value FROM samples WHERE group_id = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts',
      )
      .all(groupId, metric, fromIso, toIso) as SeriesPoint[];
  }
  const table = spanMs <= 90 * 86_400_000 ? 'rollup_hourly' : 'rollup_daily';
  const col = table === 'rollup_hourly' ? 'hour' : 'day';
  return db
    .prepare(
      `SELECT ${col} AS t, ${agg} AS value FROM ${table} WHERE group_id = ? AND metric = ? AND ${col} >= ? AND ${col} <= ? ORDER BY ${col}`,
    )
    .all(
      groupId,
      metric,
      fromIso.slice(0, col === 'hour' ? 13 : 10),
      toIso.slice(0, col === 'hour' ? 13 : 10),
    ) as SeriesPoint[];
}

/** Sum of a counter metric over a window (used for "today" style totals from samples). */
export function sumSince(db: Database.Database, groupId: string, metric: string, sinceIso: string): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(value), 0) AS s FROM samples WHERE group_id = ? AND metric = ? AND ts >= ?')
    .get(groupId, metric, sinceIso) as { s: number };
  return row.s;
}

/**
 * Sum a counter metric over [fromIso, now] for arbitrary windows (e.g. rolling 5h / 7d).
 * Splits at the 48h raw-retention boundary: precise raw samples for recent data, hourly
 * rollups for anything older — no overlap (sources never cover the same hour) and no
 * dependence on the hourly-rollup having caught up yet for recent hours.
 * `pattern` selects exact (`like=false`) or LIKE (`like=true`, for `tokens_out.%` families).
 */
export function sumWindow(
  db: Database.Database,
  groupId: string,
  pattern: string,
  fromIso: string,
  now: Date = new Date(),
  like = false,
): number {
  const op = like ? 'LIKE' : '=';
  const rawCutoff = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  // Recent portion: exact from raw samples.
  const rawFrom = fromIso > rawCutoff ? fromIso : rawCutoff;
  const raw = db
    .prepare(
      `SELECT COALESCE(SUM(value), 0) AS s FROM samples WHERE group_id = ? AND metric ${op} ? AND ts >= ? AND ts <= ?`,
    )
    .get(groupId, pattern, rawFrom, now.toISOString()) as { s: number };
  let total = raw.s;
  // Older portion (windows longer than 48h): completed hourly rollups before the raw cutoff.
  if (fromIso < rawCutoff) {
    const roll = db
      .prepare(
        `SELECT COALESCE(SUM(sum), 0) AS s FROM rollup_hourly WHERE group_id = ? AND metric ${op} ? AND hour >= ? AND hour < ?`,
      )
      .get(groupId, pattern, fromIso.slice(0, 13), rawCutoff.slice(0, 13)) as { s: number };
    total += roll.s;
  }
  return total;
}

export interface UsageBucket {
  t: string; // ISO bucket start
  msgsIn: number;
  msgsOut: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Fixed-width usage buckets (default 10 min) from raw samples, for a continuous
 * activity chart. Zero-filled across the whole range so sparse data still renders
 * as one continuous line rather than disconnected dots. The window must lie within
 * raw-sample retention (<=48h) — callers use 24h.
 */
export function usageBuckets(
  db: Database.Database,
  groupId: string,
  fromIso: string,
  toIso: string,
  bucketMs = 600_000,
): UsageBucket[] {
  const rows = db
    .prepare(
      `SELECT ts, metric, value FROM samples
       WHERE group_id = ? AND ts >= ? AND ts <= ?
         AND (metric IN ('msgs_in','msgs_out') OR metric LIKE 'tokens_in.%' OR metric LIKE 'tokens_out.%')`,
    )
    .all(groupId, fromIso, toIso) as { ts: string; metric: string; value: number }[];

  const fromMs = Math.floor(new Date(fromIso).getTime() / bucketMs) * bucketMs;
  const toMs = Math.floor(new Date(toIso).getTime() / bucketMs) * bucketMs;
  const buckets = new Map<number, UsageBucket>();
  for (let ms = fromMs; ms <= toMs; ms += bucketMs) {
    buckets.set(ms, { t: new Date(ms).toISOString(), msgsIn: 0, msgsOut: 0, tokensIn: 0, tokensOut: 0 });
  }
  for (const r of rows) {
    const key = Math.floor(new Date(r.ts).getTime() / bucketMs) * bucketMs;
    const b = buckets.get(key);
    if (!b) continue;
    if (r.metric === 'msgs_in') b.msgsIn += r.value;
    else if (r.metric === 'msgs_out') b.msgsOut += r.value;
    else if (r.metric.startsWith('tokens_in.')) b.tokensIn += r.value;
    else if (r.metric.startsWith('tokens_out.')) b.tokensOut += r.value;
  }
  return [...buckets.values()];
}

export interface GroupSlice {
  msgsIn: number;
  msgsOut: number;
  tokensIn: number;
  tokensOut: number;
}
export interface UsageBucketBreakdown extends UsageBucket {
  byGroup: Record<string, GroupSlice>;
}

function addToSlice(s: GroupSlice, metric: string, value: number): void {
  if (metric === 'msgs_in') s.msgsIn += value;
  else if (metric === 'msgs_out') s.msgsOut += value;
  else if (metric.startsWith('tokens_in.')) s.tokensIn += value;
  else if (metric.startsWith('tokens_out.')) s.tokensOut += value;
}

/**
 * Like usageBuckets but reads a set of real group ids and keeps each bucket's
 * per-group contribution (`byGroup`) alongside the totals — so a spike on the
 * "all groups" chart can be attributed to the app group that caused it.
 * Pass the real group ids (not 'all') to avoid double-counting the aggregate.
 */
export function usageBucketsByGroup(
  db: Database.Database,
  groupIds: string[],
  fromIso: string,
  toIso: string,
  bucketMs = 600_000,
): UsageBucketBreakdown[] {
  if (!groupIds.length) return [];
  const placeholders = groupIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ts, group_id, metric, value FROM samples
       WHERE group_id IN (${placeholders}) AND ts >= ? AND ts <= ?
         AND (metric IN ('msgs_in','msgs_out') OR metric LIKE 'tokens_in.%' OR metric LIKE 'tokens_out.%')`,
    )
    .all(...groupIds, fromIso, toIso) as { ts: string; group_id: string; metric: string; value: number }[];

  const fromMs = Math.floor(new Date(fromIso).getTime() / bucketMs) * bucketMs;
  const toMs = Math.floor(new Date(toIso).getTime() / bucketMs) * bucketMs;
  const buckets = new Map<number, UsageBucketBreakdown>();
  for (let ms = fromMs; ms <= toMs; ms += bucketMs) {
    buckets.set(ms, { t: new Date(ms).toISOString(), msgsIn: 0, msgsOut: 0, tokensIn: 0, tokensOut: 0, byGroup: {} });
  }
  for (const r of rows) {
    const key = Math.floor(new Date(r.ts).getTime() / bucketMs) * bucketMs;
    const b = buckets.get(key);
    if (!b) continue;
    addToSlice(b, r.metric, r.value);
    const g = (b.byGroup[r.group_id] ??= { msgsIn: 0, msgsOut: 0, tokensIn: 0, tokensOut: 0 });
    addToSlice(g, r.metric, r.value);
  }
  return [...buckets.values()];
}
