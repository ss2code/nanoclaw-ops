/**
 * Gate 1 — deterministic core: rollup math, retention pruning, JSONL token
 * parsing with offsets, latency/unanswered joins, log rotation, backup
 * round-trip. Hand-computed goldens throughout.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addEvent,
  getSeries,
  insertSamples,
  openOpsDb,
  prune,
  rollupDaily,
  rollupHourly,
  setMeta,
  getMeta,
  listIncidents,
  listOperations,
  listEventsByKind,
  lastActiveSampleMs,
  readMissionHealth,
} from './opsdb.js';
import { buildJeevesDomainSnapshot, describeEvent, knowledgeStoresSection, renderStoreDetail } from './server.js';
import { scanGroupStores, scanFleetStores } from './readers/knowledge-stores.js';
import { classifyTags, freshnessBadges, parseCalTags, readMemoryDetail } from './readers/memory-detail.js';
import {
  lintCategoryDrift,
  lintConfigDbMismatch,
  lintScopeFragmentation,
  lintStoreSeparation,
  lintUntaggedRows,
  runKnowledgeLints,
  type GroupSnapshot,
} from './readers/knowledge-lints.js';
import { readEmptyRecalls, readPerGroupMemoryStats, type MemoryRow } from './readers/memory.js';
import { fleetCard, fmtDate, fmtTs, layout } from './ui.js';
import {
  backfillSubagentReasons,
  collectTokenDeltas,
  deriveSubagentReason,
  parseUsageLines,
} from './readers/tokens.js';
import {
  applyRunFilters,
  classifyTrigger,
  computeRunFacets,
  parseRunJsonl,
  readExecutionRuns,
  runDurationMs,
  scriptIntent,
  sortRuns,
} from './readers/runs.js';
import { maybeRefreshUsageCache, readClaudeQuota, statuslineQuotaSource } from './readers/quota.js';
import {
  mergeRoutingDecisions,
  modelFamily,
  readMessageDeltas,
  readMessageJourneys,
  readRoutingDecisions,
  readSessionStats,
  readSessionWork,
  senderOf,
} from './readers/sessiondbs.js';
import { parseLogLine, rotateLogs, scanLogSignals, stripLogFormatting } from './readers/logs.js';
import { parseRouteLine } from './readers/routes.js';
import { isMemorySort, readAllGroupMemories, readMemoryDb, readMemoryEventsStats, readRecentMemoryEvents, type MemorySort } from './readers/memory.js';
import { readTripCompanions } from './readers/trips.js';
import {
  parseContainerName,
  resolveClockBefore,
  resolveClockAfter,
  parseLifecycleLine,
  ingestLifecycleLines,
  backfillLifecycle,
  buildSpans,
  unionDurationMs,
} from './readers/lifecycle.js';
import { runBackup } from './backup.js';
import { reconcileIncidents } from './incidents.js';
import { activityRibbon, allowlistCard, modelMixLine, prettyHandle, quotaChart, ribbonStat, skillsCard, skillsLine } from './ui.js';
import { senderKey, type AgentGroupInfo, type MemberInfo } from './readers/central.js';
import { isCore, listAvailableSkills, planSkillsUpdate, resolveGroupSkills, type SkillInfo } from './readers/skills.js';
import { latestConfigSnapshot, runVerifiedOperation, saveConfigSnapshot } from './operations.js';
import { calculateGroupSlo } from './slo.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opsctr-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- rollups
describe('rollups & retention', () => {
  it('aggregates completed hours with correct sum/avg/min/max/count', () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    insertSamples(db, [
      { ts: '2026-06-10T08:01:00.000Z', group_id: 'g1', metric: 'msgs_in', value: 3 },
      { ts: '2026-06-10T08:30:00.000Z', group_id: 'g1', metric: 'msgs_in', value: 5 },
      { ts: '2026-06-10T09:10:00.000Z', group_id: 'g1', metric: 'msgs_in', value: 7 }, // current hour — excluded
    ]);
    rollupHourly(db, new Date('2026-06-10T09:15:00.000Z'));
    const row = db
      .prepare("SELECT * FROM rollup_hourly WHERE hour = '2026-06-10T08' AND group_id = 'g1'")
      .get() as Record<string, number>;
    expect(row.sum).toBe(8);
    expect(row.avg).toBe(4);
    expect(row.min).toBe(3);
    expect(row.max).toBe(5);
    expect(row.count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM rollup_hourly WHERE hour = '2026-06-10T09'").get()).toEqual({ n: 0 });
    db.close();
  });

  it('rolls hourly into daily and is idempotent', () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    insertSamples(db, [
      { ts: '2026-06-09T08:00:00.000Z', group_id: 'g1', metric: 'msgs_in', value: 2 },
      { ts: '2026-06-09T22:00:00.000Z', group_id: 'g1', metric: 'msgs_in', value: 10 },
    ]);
    const now = new Date('2026-06-10T01:00:00.000Z');
    rollupHourly(db, now);
    rollupDaily(db, now);
    rollupHourly(db, now); // run twice — upsert must not double
    rollupDaily(db, now);
    const day = db.prepare("SELECT sum, count FROM rollup_daily WHERE day = '2026-06-09'").get() as Record<
      string,
      number
    >;
    expect(day.sum).toBe(12);
    expect(day.count).toBe(2);
    db.close();
  });

  it('prunes each tier at its cutoff', () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    const now = new Date('2026-06-11T00:00:00.000Z');
    insertSamples(db, [
      { ts: '2026-06-08T00:00:00.000Z', group_id: 'g', metric: 'm', value: 1 }, // 72h old — pruned at 48h
      { ts: '2026-06-10T12:00:00.000Z', group_id: 'g', metric: 'm', value: 1 }, // 12h old — kept
    ]);
    db.prepare("INSERT INTO rollup_hourly VALUES ('2026-01-01T00','g','m',1,1,1,1,1)").run(); // >90d — pruned
    db.prepare("INSERT INTO rollup_hourly VALUES ('2026-06-01T00','g','m',1,1,1,1,1)").run();
    db.prepare("INSERT INTO rollup_daily VALUES ('2024-01-01','g','m',1,1,1,1,1)").run(); // >1y — pruned
    db.prepare("INSERT INTO rollup_daily VALUES ('2026-06-01','g','m',1,1,1,1,1)").run();
    addEvent(db, { ts: '2026-01-01T00:00:00.000Z', group_id: 'g', kind: 'k', severity: 'info', detail: 'old' });
    addEvent(db, { ts: '2026-06-10T00:00:00.000Z', group_id: 'g', kind: 'k', severity: 'info', detail: 'new' });
    prune(db, now, { rawHours: 48, hourlyDays: 90, dailyDays: 365, eventDays: 90 });
    expect(db.prepare('SELECT COUNT(*) n FROM samples').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM rollup_hourly').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM rollup_daily').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 1 });
    db.close();
  });

  it('getSeries picks raw for <=48h and hourly for longer ranges', () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    insertSamples(db, [{ ts: '2026-06-10T08:00:00.000Z', group_id: 'g', metric: 'm', value: 4 }]);
    db.prepare("INSERT INTO rollup_hourly VALUES ('2026-06-08T07','g','m',9,9,9,9,1)").run();
    const raw = getSeries(db, 'g', 'm', '2026-06-10T00:00:00.000Z', '2026-06-10T12:00:00.000Z');
    expect(raw).toEqual([{ t: '2026-06-10T08:00:00.000Z', value: 4 }]);
    const hourly = getSeries(db, 'g', 'm', '2026-06-04T00:00:00.000Z', '2026-06-10T12:00:00.000Z', 'sum');
    expect(hourly).toEqual([{ t: '2026-06-08T07', value: 9 }]);
    db.close();
  });
});

describe('mission health snapshot', () => {
  it('uses the collector tick to distinguish current zeroes from old non-zero samples', () => {
    const db = openOpsDb(':memory:');
    const now = new Date('2026-08-21T10:01:00.000Z');
    insertSamples(db, [
      { ts: '2026-08-21T10:00:00.000Z', group_id: 'all', metric: 'queue_depth', value: 3 },
      { ts: '2026-08-21T10:00:00.000Z', group_id: 'all', metric: 'inflight', value: 1 },
      { ts: '2026-08-21T10:00:00.000Z', group_id: 'all', metric: 'latency_ms_max', value: 45_000 },
    ]);
    setMeta(db, 'last_sample', '2026-08-21T10:01:00.000Z');
    const health = readMissionHealth(db, now.getTime());
    expect(health).toMatchObject({ queueDepth: 0, inflight: 0, unanswered: 0, latencyMsMax: null, state: 'ok' });
    expect(health.sampleAgeMs).toBe(0);
    db.close();
  });

  it('flags a current backlog and preserves the sample age', () => {
    const db = openOpsDb(':memory:');
    const now = new Date('2026-08-21T10:01:00.000Z');
    insertSamples(db, [
      { ts: '2026-08-21T10:01:00.000Z', group_id: 'all', metric: 'queue_depth', value: 2 },
      { ts: '2026-08-21T10:01:00.000Z', group_id: 'all', metric: 'inflight', value: 1 },
      { ts: '2026-08-21T10:01:00.000Z', group_id: 'all', metric: 'latency_ms_max', value: 60_000 },
    ]);
    setMeta(db, 'last_sample', '2026-08-21T10:01:00.000Z');
    const health = readMissionHealth(db, now.getTime());
    expect(health).toMatchObject({ queueDepth: 2, inflight: 1, latencyMsMax: 60_000, state: 'warn' });
    expect(health.sampleAgeMs).toBe(0);
    db.close();
  });
});

describe('Jeeves domain read surface', () => {
  it('combines a fresh live snapshot with catalog and trip reader output', async () => {
    const snap = await buildJeevesDomainSnapshot({ tripCompanion: { showMessageSnippets: false } } as never, {
      buildLiveSnapshot: async () =>
        ({
          ts: '2026-06-29T00:00:00.000Z',
          groups: [{ id: 'ag-trip-goa', name: 'Trip Goa' }],
        }) as never,
    });

    expect(snap.ok).toBe(true);
    expect(snap.live).toMatchObject({ ts: '2026-06-29T00:00:00.000Z' });
    expect(Array.isArray(snap.apps)).toBe(true);
    expect(Array.isArray(snap.trips)).toBe(true);
  });
});

describe('ops center information architecture', () => {
  it('keeps implementation-detail pages out of the primary nav', () => {
    const html = layout('Overview', '/', '<h1>Overview</h1>', [], 'tok');
    expect(html).toContain('>Overview<');
    expect(html).not.toContain('>Triage<');
    expect(html).not.toContain('href="/triage"');
    expect(html).toContain('id="attention-status"');
    expect(html).toContain('>Runs<');
    expect(html).toContain('>Logs<');
    expect(html).toContain('>Apps<');
    // Template applications are injected by the runtime registry; the core
    // layout remains usable without any application installed.
    expect(html).not.toContain('>Tutor Foundry<');
    expect(html).toContain('>Knowledge<');
    expect(html).not.toContain('>Flows<');
    expect(html).not.toContain('>Incidents<');
    expect(html).not.toContain('>Operations<');
    expect(html).not.toContain('>Memory<');
    expect(html).not.toContain('>Activity<');
    const withTemplateApp = layout('Overview', '/', '<h1>Overview</h1>', [], 'tok', [
      { path: '/tutor-foundry', label: 'Tutor Foundry', icon: '⌁' },
    ]);
    expect(withTemplateApp).toContain('>Tutor Foundry<');
  });

  it('renders a compact live-data fleet card without overview configuration controls', () => {
    const html = fleetCard(
      {
        id: 'ag-jeeves',
        name: 'Jeeves',
        model: 'claude-sonnet-5',
        modelTiers: { high: 'claude-opus-4-8', medium: 'claude-sonnet-5', low: 'claude-haiku-4-5', default: 'high' },
        sessions: 4,
        containersUp: 1,
        minHeartbeatAgeMs: 12_000,
        currentTool: 'browser',
        queueDepth: 10,
        inflight: 4,
        todayIn: 14,
        todayOut: 10,
        unanswered: 0,
      } as never,
      {
        routingName: 'test-group',
        skills: { mode: 'all', enabledIds: [], total: 21 },
        tokensToday: [{ model: 'claude-sonnet-5', out: 205_100, in: 94_500 }],
        p95Ms: 960_000,
        latencyP95ProxyMs: 2000,
        sloWindowDays: 7,
        senders: { unique: 3, unknown: 1, top: [{ name: 'alice', channel: 'whatsapp' }, { name: 'dave', channel: 'whatsapp' }] },
        recalls: 128,
        recallHitRate: 0.82,
        spans: [],
        subagentTicks: [{ tsMs: Date.now(), model: 'claude-opus-4-8' }],
        compactionsToday: 2,
        nowMs: Date.now(),
        mix: [{ model: 'claude-opus-4-8', out: 94_500, subOut: 94_500, subSpawns: 3 }],
        wirings: [{ channel_type: 'whatsapp', engage_mode: 'mention', voice_transcription: 'on' }],
        maxMessagesPerPrompt: 10,
      } as never,
    );
    expect(html).toContain('Jeeves');
    expect(html).toContain('test-group');
    expect(html.match(/class="fc-card"/g)).toHaveLength(1);
    // Status-first redesign: config lives in the recessed "configuration" chip zone
    // (model/tiers/channels/rules/skills), the metrics on a raised hero strip.
    expect(html).toContain('configuration');
    expect(html).toContain('class="fc-hero"');
    expect(html).toContain('class="fc-chip"');
    expect(html).toContain('sonnet-5'); // model chip (from claude-sonnet-5)
    expect(html).toContain('Restart');
    expect(html).toContain('Rebuild');
    // The name bar is the ONE link to the group page — the old "Open ↗" and
    // "Configure →" duplicates are gone.
    expect(html.match(/href="\/group\//g)).toHaveLength(1);
    expect(html).not.toContain('Open ↗');
    expect(html).not.toContain('Configure');
    // recalls tile: count hero + hit-rate sub. p95 now shows the SLO latency proxy
    // (populated), cost is gone, and a senders band surfaces who messaged in 24h.
    expect(html).toContain('recalls');
    expect(html).toContain('>128<');
    expect(html).toContain('82% hit-rate');
    expect(html).not.toContain('cost');
    expect(html).toContain('p95');
    expect(html).toContain('senders');
    expect(html).toContain('alice');
    expect(html).toContain('1 unknown');
    expect(html).toContain('24h activity');
    expect(html).toContain('2 compactions');
    expect(html).toContain('class="chart ribbon"');
    expect(html).not.toContain('≈ cost');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('drawer');
    expect(html).not.toContain('disabled');
  });

  it('renders per-app store cards with lazy details (no inline bodies)', () => {
    const groupsDir = path.join(tmp, 'groups');
    const folder = path.join(groupsDir, 'sample');
    fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'CLAUDE.local.md'), 'Remember: keep Finance answers terse.');
    fs.writeFileSync(path.join(folder, 'docs', 'policy.md'), '# Policy\nUse approved vendors.');

    const db = new Database(path.join(folder, 'memory.db'));
    db.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, title TEXT, content TEXT, updated_at TEXT);
      INSERT INTO memories VALUES ('m1','Remembered preference','Use low-latency models for quick triage.','2026-07-01T08:00:00.000Z');
    `);
    db.close();

    const html = knowledgeStoresSection([{ id: 'sample', name: 'Sample', folder: 'sample' } as AgentGroupInfo], { groupsDir });

    // Per-app collapsible card + the store rows, but detail bodies are behind a
    // lazy endpoint — the heavy content is NOT embedded in the page HTML.
    expect(html).toContain('<h3>Sample</h3>');
    expect(html).toContain('data-lazy="/api/knowledge/store?group=sample');
    expect(html).toContain('groups/sample/memory.db');
    expect(html).toContain('groups/sample/CLAUDE.local.md');
    expect(html).not.toContain('Remember: keep Finance answers terse.');
    expect(html).not.toContain('Use low-latency models for quick triage.');
  });

  it('detects status enum: expected-missing (config, no db) and orphaned (db, no config)', () => {
    const groupsDir = path.join(tmp, 'groups-enum');

    // errand-runner shape: memory.config.json but no memory.db → expected-missing.
    const er = path.join(groupsDir, 'errand-runner');
    fs.mkdirSync(er, { recursive: true });
    fs.writeFileSync(path.join(er, 'memory.config.json'), JSON.stringify({ scope: 'group:errand-runner', categories: ['a', 'b'], approval: { required: true } }));

    // trip-goa shape: memory.db but no config → orphaned.
    const tg = path.join(groupsDir, 'trip-goa');
    fs.mkdirSync(tg, { recursive: true });
    const db = new Database(path.join(tg, 'memory.db'));
    db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, scope TEXT, status TEXT, importance INTEGER, access_count INTEGER, updated_at TEXT); INSERT INTO memories VALUES (1,'trip:goa','active',3,0,'2026-07-01T00:00:00Z');`);
    db.close();

    const erStores = scanGroupStores(er, { id: 'errand-runner', name: 'Errand Runner', folder: 'errand-runner' });
    const erMem = erStores.stores.find((s) => s.kind === 'curated-memory');
    expect(erMem?.status).toBe('expected-missing');
    expect(erStores.stores.some((s) => s.kind === 'engine-config' && s.status === 'present')).toBe(true);
    expect(erStores.warnCount).toBeGreaterThan(0);

    const tgStores = scanGroupStores(tg, { id: 'trip-goa', name: 'Trip Goa', folder: 'trip-goa' });
    const tgMem = tgStores.stores.find((s) => s.kind === 'curated-memory');
    expect(tgMem?.status).toBe('orphaned');
    expect(tgMem?.health.some((h) => /no memory\.config/.test(h.text))).toBe(true);

    // Mismatched groups sort to the top of the fleet listing.
    const fleet = scanFleetStores(
      [
        { id: 'errand-runner', name: 'Errand Runner', folder: 'errand-runner' } as AgentGroupInfo,
        { id: 'trip-goa', name: 'Trip Goa', folder: 'trip-goa' } as AgentGroupInfo,
      ],
      { groupsDir },
    );
    expect(fleet[0].warnCount).toBeGreaterThanOrEqual(fleet[fleet.length - 1].warnCount);
  });

  it('renderStoreDetail produces the read-only body for text and sqlite stores', () => {
    const groupsDir = path.join(tmp, 'groups-detail');
    const folder = path.join(groupsDir, 'sample');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'CLAUDE.local.md'), 'Remember: keep Finance answers terse.');
    const db = new Database(path.join(folder, 'memory.db'));
    db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, title TEXT, content TEXT, updated_at TEXT); INSERT INTO memories VALUES (1,'Remembered preference','Use low-latency models for quick triage.','2026-07-01T08:00:00.000Z');`);
    db.close();

    const stores = scanGroupStores(folder, { id: 'sample', name: 'Sample', folder: 'sample' }).stores;
    const text = renderStoreDetail(stores.find((s) => s.kind === 'local-instructions')!);
    expect(text).toContain('Remember: keep Finance answers terse.');
    const sqlite = renderStoreDetail(stores.find((s) => s.kind === 'curated-memory')!);
    expect(sqlite).toContain('memories');
  });

  it('detects a group-local docs folder', () => {
    const groupsDir = path.join(tmp, 'groups-docs');
    const folder = path.join(groupsDir, 'jeeves');
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(path.join(folder, 'docs', 'design'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'docs', 'index.html'), '<html></html>');

    const stores = scanGroupStores(folder, { id: 'jeeves', name: 'Jeeves', folder: 'jeeves' }).stores;
    expect(stores.some((s) => s.relPath === 'groups/jeeves/docs')).toBe(true);
  });
});

// ---------------------------------------------------------------- memory explorer
describe('memory explorer (Phase 2)', () => {
  it('parseCalTags handles calendarIds containing colons and rejects malformed tags', () => {
    expect(parseCalTags(['cal:primary:evt1'])).toEqual([{ calendarId: 'primary', eventId: 'evt1' }]);
    // calendarId may itself contain ':' — split on the LAST colon
    expect(parseCalTags(['cal:team@group.calendar.google.com:abc:evt'])).toEqual([
      { calendarId: 'team@group.calendar.google.com:abc', eventId: 'evt' },
    ]);
    expect(parseCalTags(['cal:onlyone', 'nope', 'trip:goa'])).toEqual([]);
  });

  it('classifyTags splits structural (cal/trip/rel/time-bound) from topical', () => {
    const { structural, topical } = classifyTags(['Priya', 'trip:goa-2026', 'cal:primary:x:y', 'time-bound', 'family']);
    expect(topical).toEqual(['Priya', 'family']);
    expect(structural.map((s) => s.kind).sort()).toEqual(['cal', 'time-bound', 'trip']);
    expect(structural.find((s) => s.kind === 'cal')?.cal).toEqual({ calendarId: 'primary:x', eventId: 'y' });
  });

  it('freshnessBadges mirrors the engine prune rule', () => {
    const base = { importance: 1, accessCount: 0, expiresAt: null, createdAt: '2020-01-01T00:00:00Z', status: 'active' };
    const badges = freshnessBadges(base).map((b) => b.text);
    expect(badges).toContain('never recalled');
    expect(badges).toContain('prune candidate');
    // recalled + recent + important → no badges
    expect(freshnessBadges({ ...base, accessCount: 3, importance: 4, createdAt: new Date().toISOString() })).toEqual([]);
    // expired
    expect(
      freshnessBadges({ ...base, accessCount: 5, importance: 4, expiresAt: '2021-01-01T00:00:00Z' }).map((b) => b.text),
    ).toContain('expired');
  });

  it('readMemoryDetail assembles row, journal, recalls (with score), and related', () => {
    const dir = path.join(tmp, 'memdetail');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'memory.db'));
    db.exec(`
      CREATE TABLE memories (id INTEGER PRIMARY KEY, category TEXT, title TEXT, content TEXT, tags TEXT, source TEXT, importance INTEGER, created_at TEXT, updated_at TEXT, scope TEXT, status TEXT, access_count INTEGER, last_accessed_at TEXT, dedup_hash TEXT, expires_at TEXT);
      INSERT INTO memories VALUES (1,'people','Priya diet','No nuts','["Priya","trip:goa-2026"]','auto',2,'2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','trip:goa','active',1,NULL,NULL,NULL);
      INSERT INTO memories VALUES (2,'people','Priya seat','Aisle','["Priya"]','auto',2,'2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','trip:goa','active',0,NULL,NULL,NULL);
      INSERT INTO memories VALUES (3,'travel','Chennai','trip','["trip:chennai-2026","cal:primary:e1","cal:primary:e2"]','auto',4,'2026-07-01T00:00:00Z','2026-07-01T00:00:00Z','group:x','active',0,NULL,NULL,NULL);
      CREATE TABLE memory_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, action TEXT, memory_id INTEGER, detail_json TEXT);
      INSERT INTO memory_journal (at, action, memory_id, detail_json) VALUES ('2026-07-01T00:00:00Z','memory.commit',1,'{"by":"Alice"}');
      CREATE TABLE memory_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, op TEXT, scope TEXT, query TEXT, hit_count INTEGER, latency_ms REAL, result_ids TEXT, score_json TEXT, actor TEXT, detail_json TEXT);
      INSERT INTO memory_events (at, op, scope, query, hit_count, latency_ms, result_ids, score_json) VALUES ('2026-07-02T00:00:00Z','recall','trip:goa','priya food',2,12,'[1,2]','[{"id":1,"total":0.71},{"id":2,"total":0.4}]');
    `);
    db.close();

    const d = readMemoryDetail(path.join(dir, 'memory.db'), 1)!;
    expect(d.row.title).toBe('Priya diet');
    expect(d.journal.map((j) => j.action)).toContain('memory.commit');
    expect(d.recalls).toHaveLength(1);
    expect(d.recalls[0].query).toBe('priya food');
    expect(d.recalls[0].score).toBeCloseTo(0.71, 2);
    // #2 was co-recalled with #1 and also shares topical tag "Priya"
    expect(d.related.some((r) => r.id === 2)).toBe(true);
    // #1 was recalled once → no never-recalled badge
    expect(d.freshness.map((b) => b.text)).not.toContain('never recalled');

    const chennai = readMemoryDetail(path.join(dir, 'memory.db'), 3)!;
    expect(chennai.structuralTags.filter((s) => s.kind === 'cal')).toHaveLength(2);
    expect(chennai.topicalTags).toEqual([]);
    expect(chennai.freshness.map((b) => b.text)).toContain('never recalled');

    expect(readMemoryDetail(path.join(dir, 'memory.db'), 999)).toBeNull();
  });
});

// ---------------------------------------------------------------- knowledge lints
describe('knowledge health & consistency lints (Phase 3)', () => {
  const row = (p: Partial<MemoryRow>): MemoryRow => ({
    id: 1,
    scope: 'group:x',
    category: 'note',
    title: '',
    content: '',
    tags: ['t'],
    source: 'auto',
    importance: 3,
    status: 'active',
    accessCount: 1,
    lastAccessedAt: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    expiresAt: null,
    ...p,
  });
  const snap = (p: Partial<GroupSnapshot>): GroupSnapshot => ({
    group: { id: 'g', name: 'G', folder: 'g' },
    hasDb: true,
    rows: [],
    config: null,
    localInstructions: null,
    ...p,
  });

  it('scope-fragmentation fires on >1 spelling of the same prefix, not on a single scope', () => {
    const frag = snap({
      group: { id: 'uk', name: 'Sample Trip', folder: 'sample-trip' },
      rows: [row({ id: 1, scope: 'trip:1' }), row({ id: 2, scope: 'trip:sample-trip' }), row({ id: 3, scope: 'trip:sample-trip' })],
    });
    const f = lintScopeFragmentation([frag]);
    expect(f).toHaveLength(1);
    // low, not high: recall spans the whole store by default, so drift no longer
    // hides rows from recall — it only splits the per-scope dedup guard.
    expect(f[0].severity).toBe('low');
    expect(f[0].evidence.join(' ')).toMatch(/trip:sample-trip — 2 rows/);
    // single scope → no finding
    expect(lintScopeFragmentation([snap({ rows: [row({ scope: 'trip:1' }), row({ id: 2, scope: 'trip:1' })] })])).toHaveLength(0);
  });

  it('category-drift fires per-group (undeclared) and fleet-wide (near-duplicate)', () => {
    const g = snap({
      group: { id: 'j', name: 'Jeeves', folder: 'j' },
      config: { categories: ['people', 'travel'] },
      rows: [row({ category: 'people' }), row({ id: 2, category: 'random' })],
    });
    const perGroup = lintCategoryDrift([g]).filter((x) => x.group === 'Jeeves');
    expect(perGroup).toHaveLength(1);
    expect(perGroup[0].evidence.join(' ')).toMatch(/random/);

    const a = snap({ group: { id: 'a', name: 'A', folder: 'a' }, rows: [row({ category: 'preference' })] });
    const b = snap({ group: { id: 'b', name: 'B', folder: 'b' }, rows: [row({ category: 'preferences' })] });
    const fleet = lintCategoryDrift([a, b]).filter((x) => x.group === 'fleet');
    expect(fleet).toHaveLength(1);
    expect(fleet[0].title).toMatch(/'preference' vs 'preferences'|'preferences' vs 'preference'/);
  });

  it('config-db-mismatch flags expected-missing and orphaned', () => {
    const expected = snap({ group: { id: 'e', name: 'Errand', folder: 'e' }, hasDb: false, config: { scope: 'group:e', categories: ['a'] } });
    const orphaned = snap({ group: { id: 'o', name: 'Orphan', folder: 'o' }, hasDb: true, config: null, rows: [row({})] });
    const findings = lintConfigDbMismatch([expected, orphaned]);
    expect(findings.find((f) => f.group === 'Errand')?.title).toMatch(/does not exist/);
    expect(findings.find((f) => f.group === 'Errand')?.severity).toBe('medium');
    expect(findings.find((f) => f.group === 'Orphan')?.title).toMatch(/no memory\.config\.json/);
  });

  it('untagged-rows fires above the threshold only', () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ id: i, tags: i < 6 ? [] : ['x'] }));
    expect(lintUntaggedRows([snap({ rows: many })])).toHaveLength(1); // 60% untagged
    const few = Array.from({ length: 10 }, (_, i) => row({ id: i, tags: i < 2 ? [] : ['x'] }));
    expect(lintUntaggedRows([snap({ rows: few })])).toHaveLength(0); // 20% untagged
  });

  it('store-separation flags task-shaped memories and dated status in CLAUDE.local.md', () => {
    const taskish = snap({ rows: [row({ title: 'TODO: book flights', content: 'status: waiting on Priya' })] });
    expect(lintStoreSeparation([taskish]).some((f) => /task-shaped/.test(f.title))).toBe(true);
    const dated = snap({ localInstructions: '# Ops\n- As of 2026-07-01 the migration is done\n' });
    expect(lintStoreSeparation([dated]).some((f) => /dated status/.test(f.title))).toBe(true);
  });

  it('produces ZERO findings on a clean fixture (no false positives)', () => {
    const clean = snap({
      group: { id: 'c', name: 'Clean', folder: 'c' },
      hasDb: true,
      config: { scope: 'group:c', categories: ['people', 'travel'] },
      localInstructions: '# Ops\n- Reply concisely.\n- Route finance questions to the dashboard.\n',
      rows: [
        row({ id: 1, scope: 'group:c', category: 'people', tags: ['a'], title: 'X likes tea', content: 'noted' }),
        row({ id: 2, scope: 'group:c', category: 'travel', tags: ['b'], title: 'Prefers aisle', content: 'noted' }),
        row({ id: 3, scope: 'group:c', category: 'people', tags: ['c'], title: 'Y is vegetarian', content: 'noted' }),
      ],
    });
    expect(runKnowledgeLints([clean])).toEqual([]);
  });
});

// ---------------------------------------------------------------- observability v2
describe('per-group observability + empty-recall mining (Phase 4)', () => {
  function fixtureDb(): string {
    const dir = path.join(tmp, 'obs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'memory.db');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE memories (id INTEGER PRIMARY KEY, category TEXT, title TEXT, content TEXT, tags TEXT, source TEXT, importance INTEGER, created_at TEXT, updated_at TEXT, scope TEXT, status TEXT, access_count INTEGER, last_accessed_at TEXT, dedup_hash TEXT, expires_at TEXT);
      INSERT INTO memories VALUES (1,'note','a','','[]','auto',3,'2026-07-01','2026-07-01','group:x','active',2,NULL,NULL,NULL);
      INSERT INTO memories VALUES (2,'note','b','','[]','auto',3,'2026-07-01','2026-07-01','group:x','active',0,NULL,NULL,NULL);
      INSERT INTO memories VALUES (3,'note','c','','[]','auto',3,'2026-07-01','2026-07-01','group:x','active',0,NULL,NULL,NULL);
      CREATE TABLE memory_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, op TEXT, scope TEXT, query TEXT, hit_count INTEGER, latency_ms REAL, result_ids TEXT, score_json TEXT, actor TEXT, detail_json TEXT);
      INSERT INTO memory_events (at, op, query, hit_count) VALUES ('2026-07-06T00:00:00Z','recall','found it',2);
      INSERT INTO memory_events (at, op, query, hit_count) VALUES ('2026-07-06T01:00:00Z','recall','missing thing',0);
      INSERT INTO memory_events (at, op, query, hit_count) VALUES ('2026-07-06T02:00:00Z','recall','MISSING  thing',0);
    `);
    db.close();
    return file;
  }

  it('readPerGroupMemoryStats computes recalls, hit-rate, and reinforcement coverage', () => {
    const dbPath = fixtureDb();
    const [s] = readPerGroupMemoryStats([{ group: { id: 'g', name: 'G', folder: 'g' }, dbPath }]);
    expect(s.rows).toBe(3);
    expect(s.recalls).toBe(3);
    expect(s.hitRate).toBeCloseTo(1 / 3, 2); // 1 of 3 recalls hit
    expect(s.emptyRecalls).toBe(2);
    expect(s.reinforcementCoverage).toBeCloseTo(1 / 3, 2); // 1 of 3 rows ever recalled
  });

  it('readEmptyRecalls mines hit_count=0 recalls, deduped by normalized query', () => {
    const dbPath = fixtureDb();
    const empties = readEmptyRecalls([{ group: { id: 'g', name: 'G', folder: 'g' }, dbPath }], { days: 36500 });
    // "missing thing" and "MISSING  thing" normalize to the same query → count 2
    const missing = empties.find((e) => /missing/i.test(e.query));
    expect(missing?.count).toBe(2);
    expect(missing?.groups).toEqual(['G']);
    // the recall that HIT is not mined
    expect(empties.some((e) => /found it/.test(e.query))).toBe(false);
  });
});

// ---------------------------------------------------------------- tokens
describe('token JSONL parsing', () => {
  const usageLine = (model: string, input: number, output: number, cr = 0, cc = 0) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-11T07:00:00.000Z',
      message: {
        model,
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: cr,
          cache_creation_input_tokens: cc,
        },
      },
    });

  it('parses assistant usage lines and skips others', () => {
    const text = [usageLine('claude-sonnet-4-6', 10, 20, 100, 5), '{"type":"user"}', 'garbage', ''].join('\n');
    const rows = parseUsageLines(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      input: 10,
      output: 20,
      cacheRead: 100,
      cacheCreate: 5,
    });
  });

  it('collects deltas incrementally via offsets (no double counting)', () => {
    const sessions = path.join(tmp, 'sessions');
    const projDir = path.join(sessions, 'ag-x', '.claude-shared', 'projects', '-workspace-agent');
    fs.mkdirSync(projDir, { recursive: true });
    const jsonl = path.join(projDir, 'a.jsonl');
    fs.writeFileSync(jsonl, usageLine('claude-haiku-4-5', 1, 2) + '\n');
    const ops = openOpsDb(path.join(tmp, 'ops.db'));

    const first = collectTokenDeltas(ops, sessions).deltas;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      groupId: 'ag-x',
      model: 'claude-haiku-4-5',
      lane: 'main',
      inputTokens: 1,
      outputTokens: 2,
      requests: 1,
    });

    expect(collectTokenDeltas(ops, sessions).deltas).toHaveLength(0); // nothing new

    fs.appendFileSync(jsonl, usageLine('claude-haiku-4-5', 3, 4) + '\n');
    const second = collectTokenDeltas(ops, sessions).deltas;
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ inputTokens: 3, outputTokens: 4 }); // only the delta
    ops.close();
  });

  it('handles a truncated trailing line (mid-write) without consuming it', () => {
    const sessions = path.join(tmp, 'sessions');
    const projDir = path.join(sessions, 'ag-x', '.claude-shared', 'projects');
    fs.mkdirSync(projDir, { recursive: true });
    const jsonl = path.join(projDir, 'a.jsonl');
    const full = usageLine('m', 1, 1) + '\n';
    fs.writeFileSync(jsonl, full + '{"type":"assistant","mess'); // partial tail
    const ops = openOpsDb(path.join(tmp, 'ops.db'));
    expect(collectTokenDeltas(ops, sessions).deltas).toHaveLength(1);
    // Offset stops at the newline; completing the line later yields it.
    fs.writeFileSync(jsonl, full + usageLine('m', 5, 5) + '\n');
    const next = collectTokenDeltas(ops, sessions).deltas;
    expect(next).toHaveLength(1);
    expect(next[0].inputTokens).toBe(5);
    ops.close();
  });

  it('reports compact boundaries once as each complete transcript line is consumed', () => {
    const sessions = path.join(tmp, 'sessions');
    const projDir = path.join(sessions, 'ag-x', '.claude-shared', 'projects', '-workspace-agent');
    fs.mkdirSync(projDir, { recursive: true });
    const jsonl = path.join(projDir, 'session-123.jsonl');
    const compactBoundary = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-07-14T10:00:00.000Z',
      content: 'Conversation compacted',
    });
    fs.writeFileSync(jsonl, compactBoundary + '\n');
    const ops = openOpsDb(path.join(tmp, 'ops.db'));

    expect(collectTokenDeltas(ops, sessions).newCompactions).toEqual([
      { groupId: 'ag-x', firstTimestamp: '2026-07-14T10:00:00.000Z', sessionId: 'session-123' },
    ]);
    expect(collectTokenDeltas(ops, sessions).newCompactions).toEqual([]);

    fs.appendFileSync(jsonl, compactBoundary + '\n');
    expect(collectTokenDeltas(ops, sessions).newCompactions).toHaveLength(1);
    ops.close();
  });
});

describe('token lanes & subagent sightings', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-lane-'));
    db = openOpsDb(path.join(root, 'ops.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const usageLine = (model: string, out: number, ts: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: { model, usage: { input_tokens: 10, output_tokens: out } },
    }) + '\n';

  const write = (rel: string, content: string) => {
    const p = path.join(root, 'sessions', 'ag-1', '.claude-shared', 'projects', '-workspace-agent', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  it('classifies lanes by path and reports new subagent files once', () => {
    write('main.jsonl', usageLine('claude-sonnet-4-6', 100, '2026-06-12T10:00:00.000Z'));
    write('main/subagents/agent-aaa.jsonl', usageLine('claude-opus-4-8', 50, '2026-06-12T10:05:00.000Z'));
    write(
      'main/subagents/workflows/wf-1/agent-bbb.jsonl',
      usageLine('claude-haiku-4-5-20251001', 20, '2026-06-12T10:06:00.000Z'),
    );

    const r1 = collectTokenDeltas(db, path.join(root, 'sessions'));
    expect(r1.deltas.find((d) => d.lane === 'main')!.model).toBe('claude-sonnet-4-6');
    expect(r1.deltas.filter((d) => d.lane === 'subagent')).toHaveLength(2);
    expect(r1.newSubagents).toHaveLength(2);
    expect(r1.newSubagents[0]).toMatchObject({ groupId: 'ag-1' });
    expect(r1.newSubagents.map((s) => s.model).sort()).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-4-8']);
    expect(r1.newSubagents.every((s) => s.firstTimestamp.startsWith('2026-06-12T10:0'))).toBe(true);

    // second pass: nothing new
    const r2 = collectTokenDeltas(db, path.join(root, 'sessions'));
    expect(r2.deltas).toHaveLength(0);
    expect(r2.newSubagents).toHaveLength(0);

    // appended usage in a known subagent file: delta yes, sighting no
    fs.appendFileSync(
      path.join(
        root,
        'sessions',
        'ag-1',
        '.claude-shared',
        'projects',
        '-workspace-agent',
        'main',
        'subagents',
        'agent-aaa.jsonl',
      ),
      usageLine('claude-opus-4-8', 30, '2026-06-12T10:10:00.000Z'),
    );
    const r3 = collectTokenDeltas(db, path.join(root, 'sessions'));
    expect(r3.deltas).toHaveLength(1);
    expect(r3.newSubagents).toHaveLength(0);
  });
});

describe('deriveSubagentReason', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-reason-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const userRec = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  const taskRec = (description: string, prompt: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Task', input: { description, prompt } }] },
    }) + '\n';

  /** Write a parent transcript + N children under <root>/<sess>/subagents/. */
  const scaffold = (sess: string, parent: string | null, children: Record<string, string>) => {
    const dir = path.join(root, sess, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    if (parent != null) fs.writeFileSync(path.join(root, `${sess}.jsonl`), parent);
    for (const [name, body] of Object.entries(children)) fs.writeFileSync(path.join(dir, name), body);
    return (name: string) => path.join(dir, name);
  };

  it('returns the parent Task description on a unique full-prompt match', () => {
    const child = scaffold(
      's1',
      taskRec('Triage AI section', 'You are triaging AI news. Focus on model releases.'),
      { 'agent-a.jsonl': userRec('You are triaging AI news. Focus on model releases.') },
    );
    expect(deriveSubagentReason(child('agent-a.jsonl'))).toBe('Triage AI section');
  });

  it('disambiguates a fan-out where children share a prompt prefix (full-prompt match)', () => {
    const parent =
      taskRec('Triage AI section', 'You are triaging news candidates for the AI section of the brief.') +
      taskRec('Triage Health section', 'You are triaging news candidates for the Health section of the brief.');
    const child = scaffold('s2', parent, {
      'agent-ai.jsonl': userRec('You are triaging news candidates for the AI section of the brief.'),
      'agent-health.jsonl': userRec('You are triaging news candidates for the Health section of the brief.'),
    });
    expect(deriveSubagentReason(child('agent-ai.jsonl'))).toBe('Triage AI section');
    expect(deriveSubagentReason(child('agent-health.jsonl'))).toBe('Triage Health section');
  });

  it('falls back to the prompt first sentence when the match is ambiguous (never a wrong description)', () => {
    // two Task blocks with the SAME prompt but different descriptions → not unique
    const parent = taskRec('Description One', 'Do the thing.') + taskRec('Description Two', 'Do the thing.');
    const child = scaffold('s3', parent, { 'agent-x.jsonl': userRec('Do the thing. Then report back.') });
    expect(deriveSubagentReason(child('agent-x.jsonl'))).toBe('Do the thing.');
  });

  it('falls back to the prompt first sentence when there is no parent transcript (workflow/script spawn)', () => {
    const child = scaffold('s4', null, {
      'agent-y.jsonl': userRec('Fetch and summarize the finance snapshot. Return top movers.'),
    });
    expect(deriveSubagentReason(child('agent-y.jsonl'))).toBe('Fetch and summarize the finance snapshot.');
  });

  it('reads the prompt from an array-of-blocks content shape', () => {
    const child = scaffold('s5', null, {
      'agent-z.jsonl': userRec([{ type: 'text', text: 'Scan the host logs for errors in the last hour.' }]),
    });
    expect(deriveSubagentReason(child('agent-z.jsonl'))).toBe('Scan the host logs for errors in the last hour.');
  });

  it('returns empty string when the transcript has no readable prompt', () => {
    const child = scaffold('s6', null, {
      'agent-none.jsonl': JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }) + '\n',
    });
    expect(deriveSubagentReason(child('agent-none.jsonl'))).toBe('');
  });
});

describe('backfillSubagentReasons', () => {
  let root: string;
  let db: Database.Database;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-backfill-'));
    db = openOpsDb(path.join(root, 'ops.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeChild = (sess: string, name: string, prompt: string) => {
    const dir = path.join(root, 'sessions', 'ag-1', '.claude-shared', 'projects', '-workspace-agent', sess, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n',
    );
  };
  const detailOf = (rid: number) =>
    JSON.parse((db.prepare('SELECT detail FROM events WHERE rowid = ?').get(rid) as { detail: string }).detail);

  it('fills a missing reason on historical events from the on-disk transcript, idempotently', () => {
    writeChild('sX', 'agent-old.jsonl', 'Summarize the quarterly earnings call. Return three bullets.');
    addEvent(db, {
      ts: '2026-07-03T06:54:00.000Z',
      group_id: 'ag-1',
      kind: 'subagent_spawn',
      severity: 'info',
      detail: JSON.stringify({ model: 'claude-haiku-4-5-20251001', file: 'agent-old.jsonl' }),
    });

    const n = backfillSubagentReasons(db, path.join(root, 'sessions'));
    expect(n).toBe(1);
    expect(detailOf(1).reason).toBe('Summarize the quarterly earnings call.');

    // idempotent: meta flag set → second run is a no-op
    expect(backfillSubagentReasons(db, path.join(root, 'sessions'))).toBe(0);
  });

  it('leaves events untouched when the reason already exists or the transcript is gone', () => {
    addEvent(db, {
      ts: '2026-07-03T06:54:00.000Z',
      group_id: 'ag-1',
      kind: 'subagent_spawn',
      severity: 'info',
      detail: JSON.stringify({ model: 'haiku', file: 'agent-has-reason.jsonl', reason: 'already set' }),
    });
    addEvent(db, {
      ts: '2026-07-03T06:55:00.000Z',
      group_id: 'ag-1',
      kind: 'subagent_spawn',
      severity: 'info',
      detail: JSON.stringify({ model: 'haiku', file: 'agent-missing.jsonl' }),
    });
    expect(backfillSubagentReasons(db, path.join(root, 'sessions'))).toBe(0);
    expect(detailOf(1).reason).toBe('already set');
    expect(detailOf(2).reason).toBeUndefined();
  });
});

describe('execution run traces', () => {
  const assistantLine = (content: unknown[], usage = { input_tokens: 10, output_tokens: 20 }) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-12T10:00:00.000Z',
      message: {
        model: 'claude-sonnet-4-6',
        usage,
        content,
      },
    }) + '\n';

  it('parses model calls, tools, skills, touched files, and a debug tag from JSONL', () => {
    const run = parseRunJsonl(
      assistantLine([
        { type: 'tool_use', name: 'Skill', input: { skill: 'trip-core' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'bun test container/skills/trip-core' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/workspace/agent/trip.ts', old_string: 'a', new_string: 'b' } },
      ]),
      { groupId: 'ag-trip', lane: 'main', file: '/tmp/session-1.jsonl' },
    );
    expect(run).toMatchObject({
      groupId: 'ag-trip',
      sessionId: 'session-1',
      lane: 'main',
      debugTag: 'group=ag-trip session=session-1',
      totals: { inputTokens: 10, outputTokens: 20, modelCalls: 1, toolCalls: 3 },
    });
    expect(run.skills).toEqual(['trip-core']);
    expect(run.files).toEqual(['/workspace/agent/trip.ts']);
    expect(run.tools.map((tool) => tool.name)).toEqual(['Skill', 'Bash', 'Edit']);
    expect(run.tools.find((tool) => tool.name === 'Bash')?.detail).toContain('bun test');
  });

  it('reads recent main and subagent traces from the session tree', () => {
    const sessions = path.join(tmp, 'sessions');
    const mainDir = path.join(sessions, 'ag-x', '.claude-shared', 'projects', '-workspace-agent');
    const subDir = path.join(mainDir, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'main.jsonl'), assistantLine([{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }]));
    fs.writeFileSync(
      path.join(subDir, 'agent-a.jsonl'),
      assistantLine([{ type: 'tool_use', name: 'Task', input: { description: 'inspect route' } }], {
        input_tokens: 4,
        output_tokens: 5,
      }),
    );

    const runs = readExecutionRuns({ sessionsRoot: sessions });
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.lane).sort()).toEqual(['main', 'subagent']);
    expect(runs.find((run) => run.lane === 'subagent')?.tools[0].summary).toBe('inspect route');
  });
});

describe('run filtering, sorting, and faceting', () => {
  const line = (ts: string, model: string, content: unknown[], out: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: { model, usage: { input_tokens: 100, output_tokens: out }, content },
    }) + '\n';

  // Run A: main, ag-1, opus, 120k out, 5-min span, touches a.ts, uses trip-core.
  const runA = parseRunJsonl(
    line('2026-06-12T10:00:00.000Z', 'claude-opus-4-8', [
      { type: 'tool_use', name: 'Skill', input: { skill: 'trip-core' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/workspace/a.ts' } },
    ], 120000) + line('2026-06-12T10:05:00.000Z', 'claude-opus-4-8', [], 0),
    { groupId: 'ag-1', lane: 'main', file: '/s/a.jsonl' },
  );
  // Run B: subagent, ag-1, haiku, 5k out, 30-sec span, touches b.ts, uses WebFetch.
  const runB = parseRunJsonl(
    line('2026-06-12T09:00:00.000Z', 'claude-haiku-4-5-20251001', [
      { type: 'tool_use', name: 'WebFetch', input: { url: 'https://x' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/workspace/b.ts' } },
    ], 5000) + line('2026-06-12T09:00:30.000Z', 'claude-haiku-4-5-20251001', [], 0),
    { groupId: 'ag-1', lane: 'subagent', file: '/s/b.jsonl' },
  );
  // Run C: main, ag-2, sonnet, 50k out, 10-min span, touches a.ts + c.ts, uses trip-finance.
  const runC = parseRunJsonl(
    line('2026-06-12T11:00:00.000Z', 'claude-sonnet-4-6', [
      { type: 'tool_use', name: 'Skill', input: { skill: 'trip-finance' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/workspace/a.ts', old_string: 'x', new_string: 'y' } },
      { type: 'tool_use', name: 'Write', input: { file_path: '/workspace/c.ts', content: 'z' } },
    ], 50000) + line('2026-06-12T11:10:00.000Z', 'claude-sonnet-4-6', [], 0),
    { groupId: 'ag-2', lane: 'main', file: '/s/c.jsonl' },
  );
  const pool = [runA, runB, runC];
  const ids = (runs: typeof pool) => runs.map((run) => run.sessionId);

  it('filters by lane, skill, tool, model, file, query, minOutput, time, and AND-combines', () => {
    expect(ids(applyRunFilters(pool, { lanes: ['subagent'] }))).toEqual(['b']);
    expect(ids(applyRunFilters(pool, { skills: ['trip-core'] }))).toEqual(['a']);
    expect(ids(applyRunFilters(pool, { tools: ['WebFetch'] }))).toEqual(['b']);
    expect(ids(applyRunFilters(pool, { models: ['opus-4-8'] }))).toEqual(['a']);
    expect(ids(applyRunFilters(pool, { file: 'a.ts' })).sort()).toEqual(['a', 'c']);
    expect(ids(applyRunFilters(pool, { query: 'trip-finance' }))).toEqual(['c']);
    expect(ids(applyRunFilters(pool, { minOutput: 60000 }))).toEqual(['a']);
    expect(ids(applyRunFilters(pool, { sinceMs: Date.parse('2026-06-12T10:30:00.000Z') }))).toEqual(['c']);
    expect(ids(applyRunFilters(pool, { groupId: 'ag-1', lanes: ['main'] }))).toEqual(['a']);
  });

  it('sorts by recency, output tokens, tool calls, and duration', () => {
    expect(ids(sortRuns(pool, 'recent'))).toEqual(['c', 'a', 'b']);
    expect(ids(sortRuns(pool, 'output'))).toEqual(['a', 'c', 'b']);
    expect(ids(sortRuns(pool, 'tools'))).toEqual(['c', 'a', 'b']);
    expect(ids(sortRuns(pool, 'duration'))).toEqual(['c', 'a', 'b']);
  });

  it('computes run-level facet counts, biggest first', () => {
    const facets = computeRunFacets(pool, {});
    expect(facets.lane).toEqual([
      { value: 'main', count: 2 },
      { value: 'subagent', count: 1 },
    ]);
    expect(facets.model.map((facet) => facet.value)).toEqual(['haiku-4-5', 'opus-4-8', 'sonnet-4-6']);
    // Counts are distinct runs, not total calls: Read is used by A and B.
    expect(facets.tool.find((facet) => facet.value === 'Read')).toEqual({ value: 'Read', count: 2 });
  });

  it("excludes a facet's own selection from its counts, but honors other filters", () => {
    const facets = computeRunFacets(pool, { lanes: ['main'] });
    // lane counts ignore the active lane filter, so subagent stays switchable.
    expect(facets.lane).toEqual([
      { value: 'main', count: 2 },
      { value: 'subagent', count: 1 },
    ]);
    // skill counts DO honor the lane filter — only the two main runs' skills.
    expect(facets.skill.map((facet) => facet.value).sort()).toEqual(['trip-core', 'trip-finance']);
  });

  it('measures wall-clock duration and handles single-timestamp runs', () => {
    expect(runDurationMs(runA)).toBe(300000);
    const instant = parseRunJsonl(
      line('2026-06-12T12:00:00.000Z', 'claude-sonnet-4-6', [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }], 1),
      { groupId: 'ag-1', lane: 'main', file: '/s/z.jsonl' },
    );
    expect(runDurationMs(instant)).toBe(0);
  });
});

describe('turn segmentation and step correlation', () => {
  const jl = (obj: unknown) => JSON.stringify(obj) + '\n';
  const userPrompt = (ts: string, text: string) => jl({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
  const assistant = (ts: string, content: unknown[], usage = { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }) =>
    jl({ type: 'assistant', timestamp: ts, message: { model: 'claude-opus-4-8', usage, content } });
  const toolResult = (ts: string, id: string, content: string, isError = false) =>
    jl({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

  const transcript =
    userPrompt('2026-07-01T10:00:00.000Z', '<context timezone="Asia/Calcutta" /> <message id="1" from="whatsapp-mg-1" sender="Alice" time="Jul 1">Deploy the trip doc please.</message>') +
    assistant('2026-07-01T10:00:05.000Z', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'netlify deploy --prod' } }]) +
    toolResult('2026-07-01T10:00:35.000Z', 'tu_1', 'Error: not authenticated', true) +
    assistant('2026-07-01T10:00:40.000Z', [{ type: 'text', text: '<message to="whatsapp-mg-1">Deploy failed — auth error.</message>' }]) +
    userPrompt('2026-07-01T20:00:00.000Z', '<context timezone="Asia/Calcutta" /> <task from="whatsapp-mg-1" time="Jul 1">Instructions: Send the nightly summary.</task>') +
    assistant('2026-07-01T20:00:10.000Z', [
      { type: 'tool_use', id: 'tu_2', name: 'Write', input: { file_path: '/tmp/report.mjs', content: '#!/usr/bin/env node\n// Build the nightly summary from ledger rows\nconsole.log(1)\n' } },
    ]) +
    toolResult('2026-07-01T20:00:12.000Z', 'tu_2', 'ok');

  const run = parseRunJsonl(transcript, { groupId: 'ag-t', lane: 'main', file: '/s/t.jsonl' });

  it('splits turns on real prompts and classifies triggers', () => {
    expect(run.turns).toHaveLength(2);
    expect(run.turns[0].trigger).toMatchObject({ kind: 'chat', label: 'Alice' });
    expect(run.turns[0].trigger.intent).toContain('Deploy the trip doc');
    expect(run.turns[1].trigger).toMatchObject({ kind: 'schedule' });
    expect(run.turns[1].trigger.intent).toContain('nightly summary');
  });

  it('correlates tool_use to tool_result: duration, error flag, result preview', () => {
    const bash = run.turns[0].tools[0];
    expect(bash.durationMs).toBe(30000);
    expect(bash.error).toBe(true);
    expect(bash.resultPreview).toContain('not authenticated');
    expect(run.turns[0].errorCount).toBe(1);
    expect(run.errorCount).toBe(1);
    expect(run.turns[1].tools[0].error).toBe(false);
  });

  it('keeps full bash commands as detail and extracts outbound messages', () => {
    expect(run.turns[0].tools[0].detail).toBe('netlify deploy --prod');
    expect(run.turns[0].outMessages).toEqual([{ to: 'whatsapp-mg-1', preview: 'Deploy failed — auth error.' }]);
    expect(run.turns[0].responsePreview).toBe('Deploy failed — auth error.');
  });

  it('surfaces written scripts as artifacts with an intent blurb', () => {
    expect(run.turns[1].artifacts).toHaveLength(1);
    expect(run.turns[1].artifacts[0]).toMatchObject({
      file: '/tmp/report.mjs',
      kind: 'script',
      via: 'write',
      intent: 'Build the nightly summary from ledger rows',
    });
    expect(run.artifacts).toHaveLength(1);
  });

  it('estimates cost from model pricing and reports context size', () => {
    // Per opus call: 100×$5 + 200×$25 + 1000×$0.5 + 50×$6.25 → in $/MTok terms.
    const perCall = (100 * 5 + 200 * 25 + 1000 * 0.5 + 50 * 6.25) / 1_000_000;
    expect(run.turns[0].costUsd).toBeCloseTo(perCall * 2, 10); // two assistant lines in turn 0
    expect(run.costUsd).toBeCloseTo(perCall * 3, 10);
    expect(run.turns[0].contextTokens).toBe(100 + 1000 + 50);
  });

  it('deduplicates repeated assistant content blocks by message.id while retaining their response', () => {
    const r = parseRunJsonl(
      userPrompt('2026-07-02T10:00:00.000Z', '<message from="cli" sender="Alice">hello</message>') +
        jl({ type: 'assistant', timestamp: '2026-07-02T10:00:01.000Z', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'text', text: 'first' }] } }) +
        jl({ type: 'assistant', timestamp: '2026-07-02T10:00:02.000Z', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'text', text: 'second' }] } }),
      { groupId: 'ag-t', lane: 'main', file: '/s/dedupe.jsonl' },
    );
    expect(r.totals).toMatchObject({ modelCalls: 1, outputTokens: 20 });
    expect(r.modelCalls[0].text).toContain('first second');
  });

  it('computes active time within turns, excluding idle gaps between turns', () => {
    // Turn 0: 10:00:00→10:00:40 all gaps < 2min → 40s. Turn 1: 20:00:00→20:00:12 → 12s.
    expect(run.turns[0].activeMs).toBe(40000);
    expect(run.turns[1].activeMs).toBe(12000);
    expect(run.activeMs).toBe(52000);
    expect(runDurationMs(run)).toBe(10 * 3600_000 + 12_000); // calendar span unchanged
  });

  it('filters and facets by trigger kind and errors', () => {
    expect(applyRunFilters([run], { triggers: ['schedule'] })).toHaveLength(1);
    expect(applyRunFilters([run], { triggers: ['a2a'] })).toHaveLength(0);
    expect(applyRunFilters([run], { errorsOnly: true })).toHaveLength(1);
    const facets = computeRunFacets([run], {});
    expect(facets.trigger.map((f) => f.value).sort()).toEqual(['chat', 'schedule']);
  });

  it('filters runs with detected memory activity', () => {
    const withMemory = parseRunJsonl(
      userPrompt('2026-07-03T10:00:00.000Z', '<message from="cli">remember this</message>') +
        assistant('2026-07-03T10:00:01.000Z', [{ type: 'tool_use', id: 'mem_1', name: 'Bash', input: { command: 'bun /app/skills/memory/scripts/memory.ts remember --title "Preference"' } }]),
      { groupId: 'ag-t', lane: 'main', file: '/s/memory.jsonl' },
    );
    expect(withMemory.turns[0].memoryOps[0]).toMatchObject({ op: 'remember', detail: 'Preference' });
    expect(applyRunFilters([run, withMemory], { memoryOnly: true })).toEqual([withMemory]);
  });

  it('counts compaction boundaries and classifies the resume prompt', () => {
    const withCompact =
      transcript +
      jl({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-07-01T21:00:00.000Z', content: 'Conversation compacted' }) +
      userPrompt('2026-07-01T21:00:01.000Z', 'This session is being continued from a previous conversation that ran out of context. The summary below covers it.') +
      assistant('2026-07-01T21:00:05.000Z', []);
    const r = parseRunJsonl(withCompact, { groupId: 'ag-t', lane: 'main', file: '/s/t2.jsonl' });
    expect(r.compactions).toBe(1);
    expect(r.turns.at(-1)?.trigger.kind).toBe('compact-resume');
  });
});

describe('trigger classification', () => {
  it('classifies the wake, a2a, command, system, task-note, and skill shapes', () => {
    expect(classifyTrigger('Continue from where you left off.').kind).toBe('wake');
    expect(classifyTrigger('<message from="unknown:agent:ag-x" sender="system" time="t">ping</message>').kind).toBe('a2a');
    expect(classifyTrigger('/task_list all')).toMatchObject({ kind: 'chat', label: 'command' });
    expect(classifyTrigger('<system>Your response was not delivered.</system>').kind).toBe('system');
    expect(classifyTrigger('<task-notification><task-id>x</task-id></task-notification>').kind).toBe('task-note');
    expect(classifyTrigger('Base directory for this skill: /home/node/.claude/skills/daily-update\n# daily-update')).toMatchObject({
      kind: 'schedule',
      label: 'skill: daily-update',
    });
  });

  it('ignores outbound-echo <message to=> blocks when classifying', () => {
    const t = classifyTrigger('<message to="someone">echo</message>\n<message from="whatsapp-mg-1" sender="Bob">hi Jeeves</message>');
    expect(t).toMatchObject({ kind: 'chat', label: 'Bob' });
  });

  it('uses the A2A origin when the formatter supplied an Unknown sender sentinel', () => {
    const t = classifyTrigger('<message from="jeeves" sender="Unknown">use model Low</message>');
    expect(t).toMatchObject({ kind: 'chat', label: 'jeeves' });
  });
});

describe('script intent extraction', () => {
  it('pulls leading comments, skipping the shebang', () => {
    expect(scriptIntent('#!/bin/bash\n# Fetch HN top stories\n# and print titles\ncurl x')).toBe('Fetch HN top stories — and print titles');
    expect(scriptIntent('// compute latency stats\nconst x = 1;')).toBe('compute latency stats');
    expect(scriptIntent('const x = 1;\n// too late')).toBeNull();
  });
});

// ---------------------------------------------------------------- session stats
describe('message deltas (rowid cursor)', () => {
  function dirWith(inRows: [string, string, string][], outRows: [string, string][]): string {
    // inRows: [id, kind, timestamp]; outRows: [id, timestamp]
    const dir = path.join(tmp, 'ag-m', 'sess-1');
    fs.mkdirSync(dir, { recursive: true });
    const inDb = new Database(path.join(dir, 'inbound.db'));
    inDb.exec(
      `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, "trigger" INTEGER, channel_type TEXT, content TEXT)`,
    );
    for (const [id, kind, ts] of inRows)
      inDb
        .prepare('INSERT INTO messages_in VALUES (?, 0, ?, ?, ?, ?, ?, ?)')
        .run(id, kind, ts, 'completed', 1, 'telegram', '{}');
    inDb.close();
    const outDb = new Database(path.join(dir, 'outbound.db'));
    outDb.exec('CREATE TABLE messages_out (id TEXT, in_reply_to TEXT, timestamp TEXT)');
    for (const [id, ts] of outRows) outDb.prepare('INSERT INTO messages_out VALUES (?, NULL, ?)').run(id, ts);
    outDb.close();
    return dir;
  }

  it('baselines on first sight (null cursor → count 0, returns current max)', () => {
    const dir = dirWith(
      [
        ['m1', 'chat-sdk', '2026-06-11T09:00:00.000Z'],
        ['t1', 'task', '2026-06-11T08:00:00.000Z'],
      ],
      [['o1', '2026-06-11 09:00:30']],
    );
    const base = readMessageDeltas(dir, null, null);
    expect(base.msgsIn).toBe(0); // no false spike from pre-existing history
    expect(base.msgsOut).toBe(0);
    expect(base.inMax).toBe(2); // rowid of last inserted (incl. the task row)
    expect(base.outMax).toBe(1);
  });

  it('counts only new rows since the cursor, excluding tasks, and is idempotent', () => {
    const dir = dirWith(
      [
        ['m1', 'chat-sdk', '2026-06-11T09:00:00.000Z'],
        ['t1', 'task', '2026-06-11T08:00:00.000Z'],
      ],
      [['o1', '2026-06-11 09:00:30']],
    );
    const base = readMessageDeltas(dir, null, null); // inMax=2, outMax=1
    // Append: one chat message, one task, one outbound whose timestamp is EARLIER
    // than the cursor wall-clock (mimics flush/mount lag) — must still count by rowid.
    const inDb = new Database(path.join(dir, 'inbound.db'));
    inDb
      .prepare('INSERT INTO messages_in VALUES (?, 0, ?, ?, ?, ?, ?, ?)')
      .run('m2', 'chat-sdk', '2026-06-11T09:05:00.000Z', 'completed', 1, 'telegram', '{}');
    inDb
      .prepare('INSERT INTO messages_in VALUES (?, 0, ?, ?, ?, ?, ?, ?)')
      .run('t2', 'task', '2026-06-11T09:06:00.000Z', 'pending', 0, null, '{}');
    inDb.close();
    const outDb = new Database(path.join(dir, 'outbound.db'));
    outDb.prepare('INSERT INTO messages_out VALUES (?, NULL, ?)').run('o2', '2026-06-11 08:59:00'); // "past" stamp, new rowid
    outDb.close();

    const d = readMessageDeltas(dir, base.inMax, base.outMax);
    expect(d.msgsIn).toBe(1); // m2 only — t2 task excluded
    expect(d.msgsOut).toBe(1); // o2 counted despite older timestamp than cursor
    expect(d.inMax).toBe(4);
    expect(d.outMax).toBe(2);

    // Re-read at the advanced cursor → nothing new.
    const none = readMessageDeltas(dir, d.inMax, d.outMax);
    expect(none.msgsIn).toBe(0);
    expect(none.msgsOut).toBe(0);
  });
});

describe('session stats (latency, unanswered, senders, queue)', () => {
  function makeSessionDir(): string {
    const dir = path.join(tmp, 'ag-x', 'sess-1');
    fs.mkdirSync(dir, { recursive: true });
    const inDb = new Database(path.join(dir, 'inbound.db'));
    inDb.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT,
      "trigger" INTEGER, channel_type TEXT, content TEXT)`);
    const outDb = new Database(path.join(dir, 'outbound.db'));
    outDb.exec(`CREATE TABLE messages_out (id TEXT, in_reply_to TEXT, timestamp TEXT);
      CREATE TABLE processing_ack (message_id TEXT, status TEXT, status_changed TEXT);
      CREATE TABLE container_state (id INTEGER PRIMARY KEY, current_tool TEXT, tool_declared_timeout_ms INTEGER, tool_started_at TEXT, updated_at TEXT);`);
    inDb.close();
    outDb.close();
    return dir;
  }

  it('computes latency joins, unanswered, queue depth and distinct senders', () => {
    const dir = makeSessionDir();
    const nowMs = new Date('2026-06-11T10:00:00.000Z').getTime();
    const inDb = new Database(path.join(dir, 'inbound.db'));
    const msg = (id: string, ts: string, trigger: number, status: string, sender: string) =>
      inDb
        .prepare('INSERT INTO messages_in VALUES (?, 0, ?, ?, ?, ?, ?, ?)')
        .run(id, 'chat-sdk', ts, status, trigger, 'telegram', JSON.stringify({ senderId: sender, senderName: sender }));
    msg('m1', '2026-06-11T09:00:00.000Z', 1, 'completed', 'alice'); // answered after 30s
    msg('m2', '2026-06-11T09:30:00.000Z', 1, 'completed', 'bob'); // never answered, 30min old → unanswered
    msg('m3', '2026-06-11T09:59:00.000Z', 1, 'pending', 'alice'); // recent, unanswered but within grace
    msg('t1', '2026-06-11T09:00:00.000Z', 0, 'pending', 'alice'); // context-only (trigger=0): no unanswered
    inDb
      .prepare(
        "INSERT INTO messages_in VALUES ('task1', 0, 'task', '2026-06-11T08:00:00.000Z', 'pending', 0, NULL, 'cron')",
      )
      .run();
    inDb.close();
    const outDb = new Database(path.join(dir, 'outbound.db'));
    outDb.prepare("INSERT INTO messages_out VALUES ('o1', 'm1', '2026-06-11T09:00:30.000Z')").run();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m3', 'processing', '2026-06-11T09:59:10.000Z')").run();
    outDb.prepare("INSERT INTO container_state VALUES (1, 'Bash', NULL, NULL, NULL)").run();
    outDb.close();

    const st = readSessionStats(dir, '2026-06-11T00:00:00.000Z', { unansweredAfterMs: 10 * 60_000, nowMs });
    expect(st.msgsIn).toBe(4); // chat messages only, not the task
    expect(st.msgsOut).toBe(1);
    expect(st.queueDepth).toBe(2); // m3 + t1 pending (chat only, task excluded)
    expect(st.inflight).toBe(1);
    expect(st.latencies).toEqual([30_000]);
    expect(st.unanswered).toBe(1); // m2 only
    expect(st.currentTool).toBe('Bash');
    expect(st.sendersToday.get('telegram')?.size).toBe(2); // alice, bob
    expect(st.scheduledTasks).toHaveLength(1);
  });

  it('handles SQLite-format outbound timestamps (space, no zone) as UTC', () => {
    // Real install: messages_in is ISO 'T...Z', messages_out is 'YYYY-MM-DD HH:MM:SS' (UTC).
    const dir = makeSessionDir();
    const nowMs = new Date('2026-06-11T10:00:00.000Z').getTime();
    const inDb = new Database(path.join(dir, 'inbound.db'));
    inDb
      .prepare('INSERT INTO messages_in VALUES (?, 0, ?, ?, ?, ?, ?, ?)')
      .run('m1', 'chat-sdk', '2026-06-11T09:00:00.000Z', 'completed', 1, 'telegram', JSON.stringify({ senderId: 'a' }));
    inDb.close();
    const outDb = new Database(path.join(dir, 'outbound.db'));
    outDb.prepare("INSERT INTO messages_out VALUES ('o1', 'm1', '2026-06-11 09:00:45')").run(); // 45s later, UTC
    outDb.close();
    const st = readSessionStats(dir, '2026-06-11T08:59:00.000Z', { unansweredAfterMs: 10 * 60_000, nowMs });
    expect(st.msgsOut).toBe(1); // space-format ts must still count in an ISO window
    expect(st.latencies).toEqual([45_000]); // and parse as UTC, not local time
    expect(st.unanswered).toBe(0);
  });

  it('senderOf falls back through senderId → author.userId → sender', () => {
    expect(senderOf(JSON.stringify({ senderId: '8' }))?.id).toBe('8');
    expect(senderOf(JSON.stringify({ author: { userId: '9' } }))?.id).toBe('9');
    expect(senderOf(JSON.stringify({ sender: 'Alice' }))?.id).toBe('Alice');
    expect(senderOf('not json')).toBeNull();
    expect(senderOf(JSON.stringify({ text: 'hi' }))).toBeNull();
  });
});

describe('message journeys', () => {
  it('reconstructs exact, inferred, processing, and delivered stages', () => {
    const dir = path.join(tmp, 'ag-j', 'sess-j');
    fs.mkdirSync(dir, { recursive: true });
    const inDb = new Database(path.join(dir, 'inbound.db'));
    inDb.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, kind TEXT, timestamp TEXT, status TEXT, "trigger" INTEGER,
      channel_type TEXT, platform_id TEXT, content TEXT);
      CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, delivered_at TEXT);`);
    const ins = inDb.prepare(
      'INSERT INTO messages_in (id, kind, timestamp, status, "trigger", channel_type, content) VALUES (?, ?, ?, ?, 1, ?, ?)',
    );
    ins.run(
      'm1',
      'chat-sdk',
      '2026-06-11T09:00:00.000Z',
      'completed',
      'telegram',
      '{"senderName":"Alice","senderId":"a"}',
    );
    ins.run(
      'm2',
      'chat-sdk',
      '2026-06-11T09:10:00.000Z',
      'completed',
      'telegram',
      '{"senderName":"Bob","senderId":"b"}',
    );
    ins.run(
      'm3',
      'chat-sdk',
      '2026-06-11T09:20:00.000Z',
      'pending',
      'telegram',
      '{"senderName":"Cara","senderId":"c"}',
    );
    inDb.prepare("INSERT INTO delivered VALUES ('o1', '2026-06-11 09:00:31')").run();
    inDb.close();
    const outDb = new Database(path.join(dir, 'outbound.db'));
    outDb.exec(`CREATE TABLE messages_out (id TEXT PRIMARY KEY, in_reply_to TEXT, timestamp TEXT);
      CREATE TABLE processing_ack (message_id TEXT PRIMARY KEY, status TEXT, status_changed TEXT);`);
    outDb.prepare("INSERT INTO messages_out VALUES ('o1','m1','2026-06-11 09:00:30')").run();
    outDb.prepare("INSERT INTO messages_out VALUES ('o2',NULL,'2026-06-11 09:10:20')").run();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m3','processing','2026-06-11 09:20:01')").run();
    outDb.close();

    const rows = readMessageJourneys(dir, { nowMs: new Date('2026-06-11T09:21:00.000Z').getTime() });
    expect(rows.find((r) => r.messageId === 'm1')).toMatchObject({ stage: 'delivered', linkage: 'exact' });
    expect(rows.find((r) => r.messageId === 'm2')).toMatchObject({ stage: 'response_written', linkage: 'inferred' });
    expect(rows.find((r) => r.messageId === 'm3')).toMatchObject({ stage: 'processing', linkage: 'none' });
  });

  it('attributes agent-to-agent messages by source group and surfaces content', () => {
    const dir = path.join(tmp, 'ag-a2a', 'sess-a2a');
    fs.mkdirSync(dir, { recursive: true });
    const inDb = new Database(path.join(dir, 'inbound.db'));
    inDb.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, kind TEXT, timestamp TEXT, status TEXT, "trigger" INTEGER,
      channel_type TEXT, platform_id TEXT, content TEXT);`);
    const ins = inDb.prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
    // Agent-to-agent hop: sender identity lives in platform_id, not content.
    ins.run('a2a-1', 'chat', '2026-06-11T09:00:00.000Z', 'completed', 'agent', 'ag-errand-runner', '{"text":"On it — pulling World Cup news now."}');
    // Human channel message: sender still resolved from content.
    ins.run('m2', 'chat-sdk', '2026-06-11T09:05:00.000Z', 'completed', 'whatsapp', null, '{"senderName":"Alice","senderId":"s","text":"thanks"}');
    inDb.close();

    const nowMs = new Date('2026-06-11T09:10:00.000Z').getTime();
    const agentNames = new Map([['ag-errand-runner', 'Errand Runner']]);

    const named = readMessageJourneys(dir, { nowMs, agentNames });
    const a2a = named.find((r) => r.messageId === 'a2a-1')!;
    expect(a2a.sender).toBe('Errand Runner'); // resolved from platform_id, not "unknown"
    expect(a2a.sourceAgentGroupId).toBe('ag-errand-runner');
    expect(a2a.preview).toBe('On it — pulling World Cup news now.');
    const human = named.find((r) => r.messageId === 'm2')!;
    expect(human.sender).toBe('Alice');
    expect(human.sourceAgentGroupId).toBeNull();
    expect(human.preview).toBe('thanks');

    // Without a name map, fall back to the raw group id — still not "unknown".
    const unnamed = readMessageJourneys(dir, { nowMs });
    expect(unnamed.find((r) => r.messageId === 'a2a-1')!.sender).toBe('ag-errand-runner');
  });
});

describe('session work', () => {
  it('collects queued, processing, failed-delivery, and scheduled task work', () => {
    const dir = path.join(tmp, 'ag-work', 'sess-work');
    fs.mkdirSync(dir, { recursive: true });
    const inDb = new Database(path.join(dir, 'inbound.db'));
    inDb.exec(`CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, series_id TEXT, kind TEXT, timestamp TEXT, status TEXT, process_after TEXT,
      recurrence TEXT, tries INTEGER DEFAULT 0, "trigger" INTEGER, channel_type TEXT, content TEXT);
      CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, status TEXT, delivered_at TEXT);`);
    const ins = inDb.prepare(
      'INSERT INTO messages_in (id, kind, timestamp, status, process_after, recurrence, "trigger", channel_type, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    ins.run(
      'm-queued',
      'chat',
      '2026-06-11T09:50:00.000Z',
      'pending',
      null,
      null,
      1,
      'telegram',
      '{"senderId":"alice","senderName":"Alice","text":"hello"}',
    );
    ins.run(
      'm-processing',
      'chat',
      '2026-06-11T09:55:00.000Z',
      'pending',
      null,
      null,
      1,
      'telegram',
      '{"senderId":"bob","senderName":"Bob","text":"working"}',
    );
    ins.run(
      'task-due',
      'task',
      '2026-06-11T08:00:00.000Z',
      'pending',
      '2026-06-11 09:00:00',
      '0 * * * *',
      0,
      null,
      '{"text":"hourly check"}',
    );
    ins.run(
      'task-paused',
      'task',
      '2026-06-11T08:00:00.000Z',
      'paused',
      '2026-06-11 11:00:00',
      null,
      0,
      null,
      'paused check',
    );
    inDb.prepare("INSERT INTO delivered VALUES ('o-failed', 'failed', '2026-06-11 09:59:01')").run();
    // task-due has been reset/retried 3× — the flapping signal surfaced in Triage.
    inDb.prepare("UPDATE messages_in SET tries = 3 WHERE id = 'task-due'").run();
    inDb.close();

    const outDb = new Database(path.join(dir, 'outbound.db'));
    outDb.exec(`CREATE TABLE messages_out (
      id TEXT PRIMARY KEY, timestamp TEXT, channel_type TEXT, content TEXT);
      CREATE TABLE processing_ack (message_id TEXT PRIMARY KEY, status TEXT, status_changed TEXT);
      CREATE TABLE container_state (id INTEGER PRIMARY KEY, current_tool TEXT);`);
    outDb.prepare("INSERT INTO messages_out VALUES ('o-failed','2026-06-11 09:59:00','telegram','send me')").run();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-processing','processing','2026-06-11 09:55:01')").run();
    outDb.prepare("INSERT INTO container_state VALUES (1,'Bash')").run();
    outDb.close();

    const work = readSessionWork(dir, { nowMs: new Date('2026-06-11T10:00:00.000Z').getTime() });
    expect(work.find((x) => x.id === 'm-queued')).toMatchObject({ state: 'queued', sender: 'Alice' });
    expect(work.find((x) => x.id === 'm-processing')).toMatchObject({
      state: 'processing',
      currentTool: 'Bash',
    });
    expect(work.find((x) => x.id === 'o-failed')).toMatchObject({ state: 'failed', kind: 'response' });
    expect(work.find((x) => x.id === 'task-due')).toMatchObject({ state: 'due', kind: 'task', tries: 3 });
    expect(work.find((x) => x.id === 'task-paused')).toMatchObject({ state: 'paused', kind: 'task', tries: 0 });
  });
});

describe('incidents', () => {
  it('correlates signals by scope, updates evidence, and resolves missing scopes', () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    const first = reconcileIncidents(
      db,
      [
        {
          scopeKey: 'group:g1',
          groupId: 'g1',
          kind: 'unanswered',
          severity: 'error',
          summary: 'one unanswered',
          recommendation: 'inspect journey',
        },
        {
          scopeKey: 'group:g1',
          groupId: 'g1',
          kind: 'queued_without_container',
          severity: 'warn',
          summary: 'queue has no container',
          recommendation: 'inspect spawn logs',
        },
      ],
      new Date('2026-06-11T10:00:00.000Z'),
    );
    expect(first.opened).toHaveLength(1);
    expect(listIncidents(db, 'open')).toHaveLength(1);
    expect(listIncidents(db, 'open')[0].summary).toContain('queue has no container');
    const second = reconcileIncidents(db, [], new Date('2026-06-11T10:05:00.000Z'));
    expect(second.resolved).toEqual(first.opened);
    expect(listIncidents(db, 'open')).toHaveLength(0);
    expect(listIncidents(db, 'resolved')[0].resolved_at).toBe('2026-06-11T10:05:00.000Z');
    db.close();
  });
});

describe('verified operations and snapshots', () => {
  it('journals pre-state, verified post-state, and result', async () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    const outcome = await runVerifiedOperation(db, {
      kind: 'test_change',
      scopeType: 'group',
      scopeId: 'g1',
      before: { model: 'haiku' },
      execute: async () => ({ ok: true, message: 'updated' }),
      verify: async () => ({ ok: true, state: { model: 'sonnet' }, message: 'model is sonnet' }),
    });
    expect(outcome.ok).toBe(true);
    const rows = listOperations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded', kind: 'test_change', scope_id: 'g1' });
    expect(JSON.parse(rows[0].after_json!)).toEqual({ model: 'sonnet' });
    db.close();
  });

  it('stores and returns the latest config snapshot', () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    saveConfigSnapshot(db, 'g1', 'model_change', { model: 'haiku' });
    saveConfigSnapshot(db, 'g1', 'model_change', { model: 'sonnet' });
    expect(latestConfigSnapshot(db, 'g1', 'model_change')?.config).toEqual({ model: 'sonnet' });
    db.close();
  });

  it('executes and verifies a declared rollback when the postcondition fails', async () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    const calls: string[] = [];
    const outcome = await runVerifiedOperation(db, {
      kind: 'provider_switch',
      scopeType: 'group',
      scopeId: 'g1',
      before: { provider: 'codex' },
      rollback: { provider: 'codex' },
      execute: async () => ({ ok: true, message: 'switched to pi' }),
      verify: async () => ({ ok: false, state: { provider: 'pi' }, message: 'Pi probe failed' }),
      rollbackExecute: async () => {
        calls.push('execute');
        return { ok: true, message: 'restored codex' };
      },
      rollbackVerify: async () => {
        calls.push('verify');
        return { ok: true, state: { provider: 'codex' }, message: 'codex restored' };
      },
    });
    expect(calls).toEqual(['execute', 'verify']);
    expect(outcome).toMatchObject({ ok: false, status: 'rolled_back' });
    expect(listOperations(db)[0].result).toContain('rollback verified');
    db.close();
  });
});

describe('SLO baseline', () => {
  it('calculates response ratio, latency proxy, tokens per response, and passive canary', () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    insertSamples(db, [
      { ts: '2026-06-11T09:00:00.000Z', group_id: 'g1', metric: 'msgs_in', value: 10 },
      { ts: '2026-06-11T09:00:00.000Z', group_id: 'g1', metric: 'msgs_out', value: 8 },
      { ts: '2026-06-11T09:00:00.000Z', group_id: 'g1', metric: 'tokens_out.sonnet', value: 800 },
      { ts: '2026-06-11T09:00:00.000Z', group_id: 'g1', metric: 'latency_ms_max', value: 12_000 },
      { ts: '2026-06-11T09:01:00.000Z', group_id: 'g1', metric: 'unanswered', value: 1 },
    ]);
    const slo = calculateGroupSlo(
      db,
      'g1',
      [
        {
          messageId: 'm',
          sessionId: 's',
          receivedAt: '2026-06-11T09:00:00.000Z',
          sender: 'a',
          channel: 'telegram',
          sourceAgentGroupId: null,
          preview: 'hi',
          inboundStatus: 'completed',
          ackStatus: 'completed',
          responseId: 'o',
          responseAt: '2026-06-11T09:00:10.000Z',
          deliveredAt: '2026-06-11T09:00:11.000Z',
          linkage: 'exact',
          stage: 'delivered',
          ageMs: 0,
        },
      ],
      new Date('2026-06-11T10:00:00.000Z'),
    );
    expect(slo.responseRatio).toBe(0.8);
    expect(slo.latencyP95ProxyMs).toBe(12_000);
    expect(slo.tokensPerResponse).toBe(100);
    expect(slo.unansweredSamples).toBe(1);
    expect(slo.passiveCanary.status).toBe('healthy');
    db.close();
  });
});

// ---------------------------------------------------------------- logs
describe('log signals & rotation', () => {
  it('strips formatting and parses structured log fields', () => {
    const raw =
      '[09:03:43.321] \\x1b[31mERROR\\x1b[39m \\x1b[36mCLI response written\\x1b[39m requestId="r1" ok=false sessionId="sess-1" agentGroup="ag-1"';
    expect(stripLogFormatting(raw)).not.toContain('\\x1b');
    expect(parseLogLine(raw)).toMatchObject({
      clock: '09:03:43.321',
      level: 'error',
      category: 'cli',
      message: 'CLI response written',
      sessionId: 'sess-1',
      groupId: 'ag-1',
    });
    expect(parseLogLine('[09:00:00.000] INFO CLI response written ok=false sessionId="s1"')).toMatchObject({
      level: 'warn',
      category: 'cli',
    });
  });

  it('parses inbound routing and agent forwarding events', () => {
    expect(
      parseRouteLine(
        '[09:03:43.321] INFO Message routed sessionId="sess-1" agentGroup="ag-1" engage_mode="pattern" kind="chat-sdk" userId="telegram:8" wake=true created=false agentGroupName="shyNano"',
      ),
    ).toEqual({
      kind: 'inbound',
      clock: '09:03:43.321',
      sessionId: 'sess-1',
      agentGroupId: 'ag-1',
      agentGroupName: 'shyNano',
      engageMode: 'pattern',
      channelKind: 'chat-sdk',
      userId: 'telegram:8',
      wake: true,
      created: false,
    });
    expect(
      parseRouteLine(
        '[09:04:01.000] INFO Agent message routed from="ag-1" to="ag-2" targetSession="sess-2" a2aMsgId="a2a-1" forwardedFileCount=2',
      ),
    ).toEqual({
      kind: 'forward',
      clock: '09:04:01.000',
      fromGroupId: 'ag-1',
      toGroupId: 'ag-2',
      targetSession: 'sess-2',
      messageId: 'a2a-1',
      forwardedFileCount: 2,
    });
  });

  it('classifies rate-limit, kill and error lines', () => {
    const sig = scanLogSignals(
      [
        '[10:00:00.000] ERROR delivery failed err=429 rate_limit_error',
        '[10:00:01.000] WARN Killing container sessionId=s1 reason=absolute-ceiling',
        '[10:00:02.000] INFO Message routed',
        '[10:00:03.000] FATAL crash',
      ].join('\n'),
    );
    expect(sig.rateLimitEvents).toHaveLength(1);
    expect(sig.killEvents).toHaveLength(1);
    expect(sig.killEvents[0]).toMatchObject({ reason: 'absolute-ceiling', abnormal: false });
    expect(sig.errorLines).toHaveLength(2);
    expect(sig.newLines).toHaveLength(4);
  });

  it('does not classify timestamp milliseconds as rate limits', () => {
    const sig = scanLogSignals(
      [
        '[15:29:57.429] INFO Channel adapter stopped channel="whatsapp"',
        '[14:50:02.529] INFO Fetched WA Web version from Baileys',
        '[14:50:08.429] INFO Reconnecting...',
      ].join('\n'),
    );

    expect(sig.rateLimitEvents).toEqual([]);
  });

  it('de-dupes the 2 log lines of one kill into a single kill event', () => {
    // A real absolute-ceiling reap emits a host-sweep WARN pre-log (no reason=)
    // plus the canonical killContainer INFO line (reason="…"). Only the latter
    // should count — otherwise the crash-loop alert double-counts every reap.
    const sig = scanLogSignals(
      [
        '[18:56:54.464] WARN Killing container past absolute ceiling sessionId="s1" heartbeatAgeMs=1805464 ceilingMs=1800000',
        '[18:56:54.465] INFO Killing container sessionId="s1" reason="absolute-ceiling" containerName="nanoclaw-v2-dm"',
      ].join('\n'),
    );
    expect(sig.killEvents).toHaveLength(1);
    expect(sig.killEvents[0].reason).toBe('absolute-ceiling');
    expect(sig.killEvents[0].abnormal).toBe(false);
  });

  it('marks only claim-stuck kills abnormal; idle GC + intentional restarts are normal', () => {
    const sig = scanLogSignals(
      [
        '[10:00:00.000] INFO Killing container sessionId="s1" reason="absolute-ceiling" containerName="c1"',
        '[10:00:01.000] INFO Killing container sessionId="s2" reason="claim-stuck" containerName="c2"',
        '[10:00:02.000] INFO Killing container sessionId="s3" reason="restarted via ncl" containerName="c3"',
        '[10:00:03.000] INFO Killing container sessionId="s4" reason="rebuild applied" containerName="c4"',
        // Follow-on reset lines carry reason= but are NOT "Killing container" — must not count.
        '[10:00:04.000] INFO Reset stale message with backoff messageId="m1" tries=1 backoffMs=5000 reason="claim-stuck"',
        '[10:00:05.000] INFO Cleared orphan processing claims sessionId="s2" cleared=1 reason="claim-stuck"',
      ].join('\n'),
    );
    expect(sig.killEvents).toHaveLength(4);
    expect(sig.killEvents.filter((k) => k.abnormal).map((k) => k.reason)).toEqual(['claim-stuck']);
    expect(sig.killEvents.filter((k) => !k.abnormal).map((k) => k.reason)).toEqual([
      'absolute-ceiling',
      'restarted via ncl',
      'rebuild applied',
    ]);
  });

  it('rotates by copy-truncate and prunes old generations', () => {
    const log = path.join(tmp, 'nanoclaw.log');
    const archive = path.join(tmp, 'archive');
    fs.writeFileSync(log, 'x'.repeat(2048));
    const r1 = rotateLogs([log], 1024, 2, archive, '2026-06-11T01:00:00.000Z');
    expect(r1.rotated).toHaveLength(1);
    expect(fs.statSync(log).size).toBe(0); // truncated in place, not renamed
    const gz = fs.readFileSync(r1.rotated[0]);
    expect(zlib.gunzipSync(gz).toString()).toBe('x'.repeat(2048));
    // two more rotations → keep=2 prunes the oldest
    fs.writeFileSync(log, 'y'.repeat(2048));
    rotateLogs([log], 1024, 2, archive, '2026-06-11T02:00:00.000Z');
    fs.writeFileSync(log, 'z'.repeat(2048));
    const r3 = rotateLogs([log], 1024, 2, archive, '2026-06-11T03:00:00.000Z');
    expect(r3.removed).toHaveLength(1);
    expect(fs.readdirSync(archive)).toHaveLength(2);
  });

  it('does not rotate below the threshold', () => {
    const log = path.join(tmp, 'small.log');
    fs.writeFileSync(log, 'tiny');
    expect(rotateLogs([log], 1024, 2, path.join(tmp, 'arch')).rotated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- backup
describe('central DB backup', () => {
  it('VACUUM INTO produces a restorable gzipped snapshot and prunes retention', () => {
    const src = path.join(tmp, 'v2.db');
    const db = new Database(src);
    db.exec("CREATE TABLE agent_groups (id TEXT, name TEXT); INSERT INTO agent_groups VALUES ('ag-1', 'Test')");
    db.close();
    const backups = path.join(tmp, 'backups');
    const res = runBackup(src, backups, 2, '2026-06-11T03:30:00.000Z');
    expect(res.ok).toBe(true);
    // restore round-trip
    const restored = path.join(tmp, 'restored.db');
    fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(res.file!)));
    const rdb = new Database(restored, { readonly: true });
    expect(rdb.prepare('SELECT name FROM agent_groups').get()).toEqual({ name: 'Test' });
    rdb.close();
    // retention: 3 dated backups with keep=2 → oldest pruned
    runBackup(src, backups, 2, '2026-06-12T03:30:00.000Z');
    const res3 = runBackup(src, backups, 2, '2026-06-13T03:30:00.000Z');
    expect(res3.pruned).toEqual(['v2-2026-06-11.db.gz']);
    expect(fs.readdirSync(backups).filter((f) => f.endsWith('.gz'))).toHaveLength(2);
  });

  it('reports failure for a missing source db', () => {
    const res = runBackup(path.join(tmp, 'missing.db'), path.join(tmp, 'b'), 2);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------- orphans
describe('orphan detection & safe cleanup', () => {
  async function setup() {
    const { findOrphans, cleanupOrphan } = await import('./orphans.js');
    const sessions = path.join(tmp, 'v2-sessions');
    const groupsDir = path.join(tmp, 'groups');
    fs.mkdirSync(path.join(sessions, 'ag-live'), { recursive: true });
    fs.mkdirSync(path.join(sessions, 'ag-deleted'), { recursive: true });
    fs.writeFileSync(path.join(sessions, 'ag-deleted', 'inbound.db'), 'x'.repeat(100));
    fs.mkdirSync(path.join(groupsDir, 'live-folder'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, '_ping-test'), { recursive: true });
    const groups = [{ id: 'ag-live', folder: 'live-folder' }];
    return { findOrphans, cleanupOrphan, sessions, groupsDir, groups };
  }

  it('flags only directories with no matching agent group', async () => {
    const { findOrphans, sessions, groupsDir, groups } = await setup();
    const orphans = findOrphans(sessions, groupsDir, groups);
    expect(orphans.map((o) => o.name).sort()).toEqual(['_ping-test', 'ag-deleted']);
    const sess = orphans.find((o) => o.name === 'ag-deleted')!;
    expect(sess.kind).toBe('session-data');
    expect(sess.sizeBytes).toBe(100);
  });

  it('cleanup moves an orphan to trash and refuses non-orphans', async () => {
    const { findOrphans, cleanupOrphan, sessions, groupsDir, groups } = await setup();
    const trash = path.join(tmp, 'trash');
    const orphan = findOrphans(sessions, groupsDir, groups).find((o) => o.name === 'ag-deleted')!;
    const res = cleanupOrphan(orphan.relPath, {
      sessionsRoot: sessions,
      groupsRoot: groupsDir,
      trashRoot: trash,
      groups,
      stamp: '2026-06-11T10:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(sessions, 'ag-deleted'))).toBe(false); // moved away…
    expect(
      fs.readFileSync(path.join(trash, '2026-06-11T10-00-00', 'session-data-ag-deleted', 'inbound.db'), 'utf8'),
    ).toBe(
      'x'.repeat(100), // …intact in trash (reversible)
    );
    // A live group's dir must be refused even if someone forges the path.
    const live = cleanupOrphan(path.relative(path.resolve(tmp, '..'), path.join(sessions, 'ag-live')), {
      sessionsRoot: sessions,
      groupsRoot: groupsDir,
      trashRoot: trash,
      groups,
    });
    expect(live.ok).toBe(false);
    expect(fs.existsSync(path.join(sessions, 'ag-live'))).toBe(true);
  });
});

// ---------------------------------------------------------------- meta
describe('meta kv', () => {
  it('set/get round-trips and upserts', () => {
    const db = openOpsDb(path.join(tmp, 'ops.db'));
    setMeta(db, 'k', '1');
    setMeta(db, 'k', '2');
    expect(getMeta(db, 'k')).toBe('2');
    expect(getMeta(db, 'absent')).toBeUndefined();
    db.close();
  });
});

// ---------------------------------------------------------------- memory
describe('memory dashboard reader', () => {
  // A unified-engine memory.db at groups/<folder>/memory.db. Optionally seeds the
  // memory_events observability table.
  function makeMemoryDb(folder: string, opts: { withEvents?: boolean } = {}): { groupsDir: string; dbPath: string } {
    const groupsDir = path.join(tmp, 'groups');
    const dir = path.join(groupsDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'memory.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL DEFAULT 'group:default',
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        source TEXT,
        importance INTEGER DEFAULT 3,
        status TEXT NOT NULL DEFAULT 'active',
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        dedup_hash TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
      INSERT INTO meta VALUES ('owner_id', 'Alice');
    `);
    const ins = db.prepare(
      'INSERT INTO memories (scope,category,title,content,tags,source,importance,status,access_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    );
    ins.run('group:test-group', 'projects', 'Memory dashboard', 'Expose memory through a read-only Ops Center tab', '["ops-center","memory"]', 'conversation:2026-06-12', 5, 'active', 3, '2026-06-12 04:00:00', '2026-06-12 04:00:00');
    ins.run('group:test-group', 'preferences', 'Approval boundary', 'All memory writes require explicit approval', '["security"]', 'manual', 5, 'active', 0, '2026-06-12 05:00:00', '2026-06-12 05:00:00');
    ins.run('group:test-group', 'projects', 'Pending idea', 'A proposed memory awaiting approval', '[]', 'auto', 2, 'pending', 0, '2026-06-12 06:00:00', '2026-06-12 06:00:00');
    if (opts.withEvents) {
      db.exec(`
        CREATE TABLE memory_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, op TEXT, scope TEXT, query TEXT,
          hit_count INTEGER, latency_ms INTEGER, result_ids TEXT, score_json TEXT, actor TEXT, detail_json TEXT
        );
      `);
      const ev = db.prepare(
        'INSERT INTO memory_events (at,op,scope,query,hit_count,latency_ms,score_json,actor,detail_json) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      ev.run('2026-06-12T05:00:00Z', 'recall', 'group:test-group', 'ops center', 2, 12, '[{"id":1,"score":0.91},{"id":2,"score":0.42}]', 'agent', null);
      ev.run('2026-06-12T05:01:00Z', 'recall', 'group:test-group', 'nonexistent', 0, 8, '[]', 'agent', null);
      ev.run('2026-06-12T05:02:00Z', 'remember', 'group:test-group', null, null, null, null, 'Alice', '{"duplicate":true}');
      ev.run('2026-06-12T05:03:00Z', 'approve', 'group:test-group', null, null, null, null, 'Alice', null);
    }
    db.close();
    return { groupsDir, dbPath };
  }

  const GROUP: AgentGroupInfo = { id: 'ag-dm', name: 'DM with Alice', folder: 'dm', model: null, provider: null, cli_scope: 'global', model_tiers: null };

  it('reads unified memory across groups, defaults to active, and exposes scope + facets', () => {
    const { groupsDir } = makeMemoryDb('dm');
    const all = readAllGroupMemories([GROUP], { groupsDir });
    expect(all.groupsWithMemory).toBe(1);
    expect(all.totalMemories).toBe(3);
    expect(all.totalPending).toBe(1);
    // default status=active hides the pending proposal
    expect(all.rows).toHaveLength(2);
    expect(all.rows.every((r) => r.status === 'active')).toBe(true);
    expect(all.rows[0].group?.name).toBe('DM with Alice');
    expect(all.scopes).toEqual(['group:test-group']);
    expect(all.categories.map((c) => c.category).sort()).toEqual(['preferences', 'projects']);
  });

  it('filters by status, category, group, and free text; per-DB read keeps rich rows', () => {
    const { groupsDir } = makeMemoryDb('dm');
    expect(readAllGroupMemories([GROUP], { groupsDir, status: 'pending' }).rows).toHaveLength(1);
    expect(readAllGroupMemories([GROUP], { groupsDir, status: 'all' }).rows).toHaveLength(3);
    expect(readAllGroupMemories([GROUP], { groupsDir, category: 'preferences' }).rows).toHaveLength(1);
    expect(readAllGroupMemories([GROUP], { groupsDir, q: 'dashboard' }).rows.map((r) => r.title)).toEqual([
      'Memory dashboard',
    ]);
    expect(readAllGroupMemories([GROUP], { groupsDir, group: 'no-such' }).rows).toHaveLength(0);

    const { dbPath } = makeMemoryDb('dm2');
    const snap = readMemoryDb(dbPath);
    expect(snap).toMatchObject({ available: true, total: 3, active: 2, pending: 1, owner: 'Alice' });
    const dash = snap.rows.find((r) => r.title === 'Memory dashboard');
    expect(dash?.scope).toBe('group:test-group');
    expect(dash?.accessCount).toBe(3);
  });

  it('defaults to newest-first and honors every sort option', () => {
    const { groupsDir } = makeMemoryDb('dm');
    const titles = (sort?: MemorySort) =>
      readAllGroupMemories([GROUP], { groupsDir, status: 'all', sort }).rows.map((r) => r.title);

    // Fixture: Memory dashboard (imp 5, 3 recalls, 04:00), Approval boundary
    // (imp 5, 0 recalls, 05:00), Pending idea (imp 2, 0 recalls, 06:00).
    expect(titles()).toEqual(['Pending idea', 'Approval boundary', 'Memory dashboard']);
    expect(titles('newest')).toEqual(['Pending idea', 'Approval boundary', 'Memory dashboard']);
    expect(titles('oldest')).toEqual(['Memory dashboard', 'Approval boundary', 'Pending idea']);
    expect(titles('updated')).toEqual(['Pending idea', 'Approval boundary', 'Memory dashboard']);
    // Importance ties break newest-first, so Approval boundary precedes Memory dashboard.
    expect(titles('importance')).toEqual(['Approval boundary', 'Memory dashboard', 'Pending idea']);
    expect(titles('recalls')).toEqual(['Memory dashboard', 'Pending idea', 'Approval boundary']);

    // An unknown ?sort= value falls back to the default rather than throwing.
    expect(readAllGroupMemories([GROUP], { groupsDir, status: 'all', sort: 'bogus' as MemorySort }).rows[0].title).toBe('Pending idea');
    expect(isMemorySort('recalls')).toBe(true);
    expect(isMemorySort('bogus')).toBe(false);
  });

  it('aggregates memory_events observability and degrades gracefully when empty', () => {
    const withEvents = makeMemoryDb('dm-ev', { withEvents: true });
    const stats = readMemoryEventsStats([withEvents.dbPath]);
    expect(stats.available).toBe(true);
    expect(stats.totalEvents).toBe(4);
    expect(stats.recalls).toBe(2);
    expect(stats.hitRate).toBe(0.5);
    expect(stats.emptyRecallRate).toBe(0.5);
    expect(stats.p50Ms).toBe(8);
    expect(stats.p95Ms).toBe(12);
    expect(stats.writes).toBe(1);
    expect(stats.approvals).toBe(1);
    expect(stats.dedupCollisions).toBe(1);

    const recent = readRecentMemoryEvents([withEvents.dbPath], 10);
    expect(recent).toHaveLength(4);
    expect(recent[0].op).toBe('approve'); // newest first
    expect(recent.find((e) => e.op === 'recall' && e.hitCount === 2)?.scoreTrace).toContain('#1:0.91');

    // a DB with no memory_events table → graceful empty stats, never NaN
    const noEvents = makeMemoryDb('dm-noev');
    const empty = readMemoryEventsStats([noEvents.dbPath]);
    expect(empty.available).toBe(false);
    expect(empty.hitRate).toBeNull();
    expect(empty.p95Ms).toBeNull();
    expect(readRecentMemoryEvents([noEvents.dbPath])).toEqual([]);
  });

  it('reports unavailable databases without throwing', () => {
    expect(readMemoryDb(path.join(tmp, 'missing.db')).available).toBe(false);
    expect(readAllGroupMemories([GROUP], { groupsDir: path.join(tmp, 'no-groups') }).groupsWithMemory).toBe(0);
  });
});

// ---------------------------------------------------------------- trip companion
describe('Trip Companion dashboard reader', () => {
  it('shows host-mounted trip state, memory rows, warnings, and grounding evidence', () => {
    const groupsDir = path.join(tmp, 'groups');
    const sessionsDir = path.join(tmp, 'sessions');
    const groupDir = path.join(groupsDir, 'summer-trip');
    const sessionDir = path.join(sessionsDir, 'ag-summer', 'sess-1');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });

    const core = new Database(path.join(groupDir, 'trip.db'));
    core.exec(`
      CREATE TABLE trip (id INTEGER PRIMARY KEY, name TEXT, stage TEXT, status TEXT);
      CREATE TABLE members (
        id INTEGER PRIMARY KEY, display_name TEXT, left_at TEXT, excluded_from_splits INTEGER
      );
      INSERT INTO members VALUES (1, 'Alice', NULL, 0);
      CREATE TABLE families (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO families VALUES (1, 'Alice-Bob');
      CREATE TABLE decisions (id INTEGER PRIMARY KEY, status TEXT);
      INSERT INTO decisions VALUES (1, 'open');
      CREATE TABLE scratchpad (id INTEGER PRIMARY KEY, status TEXT);
    `);
    core.close();

    const memory = new Database(path.join(groupDir, 'memory.db'));
    memory.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY, category TEXT, title TEXT, content TEXT, source TEXT,
        importance INTEGER, status TEXT, updated_at TEXT
      );
      INSERT INTO memories VALUES
        (1, 'preferences', 'Pace', 'Active mornings', 'owner-approved', 9, 'active', '2026-06-15T10:00:00Z'),
        (2, 'preferences', 'Old', 'Rejected item', 'auto', 2, 'rejected', '2026-06-15T09:00:00Z');
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
      INSERT INTO meta VALUES ('owner_id', 'Alice');
    `);
    memory.close();

    const workflows = new Database(path.join(groupDir, 'workflows.db'));
    workflows.exec(`
      CREATE TABLE workflow_instances (
        id TEXT PRIMARY KEY, status TEXT, updated_at TEXT
      );
      INSERT INTO workflow_instances VALUES
        ('wf-1', 'waiting', '2026-06-15T10:02:00Z'),
        ('wf-2', 'action_required', '2026-06-15T10:03:00Z');
      CREATE TABLE workflow_actions (
        id TEXT PRIMARY KEY, action_type TEXT, status TEXT, review_status TEXT
      );
      INSERT INTO workflow_actions VALUES
        ('act-1', 'create_gmail_draft', 'review_pending', 'review_pending'),
        ('act-2', 'app_write', 'failed', NULL);
      CREATE TABLE workflow_timers (
        id TEXT PRIMARY KEY, status TEXT, due_at TEXT
      );
      INSERT INTO workflow_timers VALUES ('timer-1', 'scheduled', '2026-06-16T10:00:00Z');
    `);
    workflows.close();

    const outbound = new Database(path.join(sessionDir, 'outbound.db'));
    outbound.exec(`
      CREATE TABLE messages_out (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, kind TEXT NOT NULL, channel_type TEXT, content TEXT
      );
      INSERT INTO messages_out VALUES
        ('out-1', '2026-06-15 10:06:00', 'chat', 'whatsapp', '{"text":"Saved the itinerary preference."}');
      CREATE TABLE grounding_events (
        id INTEGER PRIMARY KEY, created_at TEXT, completed_at TEXT, core_ok INTEGER, memory_ok INTEGER,
        errors_json TEXT, remember_requested INTEGER, remember_satisfied INTEGER,
        memory_count_before INTEGER, memory_count_after INTEGER
      );
      INSERT INTO grounding_events VALUES
        (1, '2026-06-15T10:05:00Z', '2026-06-15T10:05:02Z', 1, 1, '[]', 1, 0, 1, 1);
    `);
    outbound.close();

    const inbound = new Database(path.join(sessionDir, 'inbound.db'));
    inbound.exec(`
      CREATE TABLE messages_in (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, kind TEXT NOT NULL, status TEXT,
        trigger INTEGER, channel_type TEXT, content TEXT
      );
      INSERT INTO messages_in VALUES
        ('in-1', '2026-06-15T10:04:00.000Z', 'chat', 'completed', 1, 'whatsapp',
         '{"senderId":"u1","senderName":"Asha","text":"Please remember that mornings should start early."}');
    `);
    inbound.close();

    const [trip] = readTripCompanions(
      [
        {
          id: 'ag-summer',
          name: 'Summer Trip',
          folder: 'summer-trip',
          model: 'sonnet',
          provider: null,
          cli_scope: 'group',
          model_tiers: null,
        },
      ],
      {
        groupsDir,
        sessionsDir,
        showMessageSnippets: true,
        logEvents: [
          {
            source: 'nanoclaw.log',
            clock: '2026-06-15T10:07:00.000Z',
            level: 'info',
            category: 'routing',
            message: 'Message routed',
            groupId: 'ag-summer',
            sessionId: 'sess-1',
            fields: { agentGroup: 'ag-summer' },
            line: '[2026-06-15T10:07:00.000Z] INFO Message routed agentGroup=ag-summer sessionId=sess-1',
          },
        ],
      },
    );
    expect(trip.core.activeMembers).toBe(1);
    expect(trip.core.configured).toBe(false);
    expect(trip.memory).toMatchObject({ total: 2, active: 1, rejected: 1, owner: 'Alice' });
    expect(trip.memory.rows[0].content).toBe('Active mornings');
    expect(trip.workflows).toMatchObject({
      available: true,
      total: 2,
      byStatus: { waiting: 1, action_required: 1 },
      pendingDrafts: 1,
      failedActions: 1,
      nextTimer: '2026-06-16T10:00:00Z',
    });
    expect(trip.databases.map((db) => db.label)).toEqual([
      'groups/summer-trip/memory.db',
      'groups/summer-trip/trip.db',
      'groups/summer-trip/workflows.db',
      'sessions/sess-1/inbound.db',
      'sessions/sess-1/outbound.db',
    ]);
    expect(trip.databases.find((db) => db.label.endsWith('trip.db'))?.tables.map((table) => table.name)).toContain(
      'members',
    );
    const memoryPreview = trip.databases
      .find((db) => db.label.endsWith('memory.db'))
      ?.tables.find((table) => table.name === 'memories')?.previewRows;
    expect(memoryPreview?.[0]).toMatchObject({ title: 'Pace', content: 'Active mornings' });
    expect(trip.operations.some((event) => event.source === 'log' && event.summary === 'Message routed')).toBe(true);
    expect(
      trip.operations.some(
        (event) => event.source === 'inbound' && event.snippet?.includes('mornings should start early'),
      ),
    ).toBe(true);
    expect(
      trip.operations.some((event) => event.source === 'outbound' && event.snippet?.includes('itinerary preference')),
    ).toBe(true);
    expect(trip.grounding[0]).toMatchObject({
      coreOk: true,
      memoryOk: true,
      rememberRequested: true,
      rememberSatisfied: false,
    });
    expect(trip.warnings).toContain('trip-core has tables but no configured trip row');
    expect(trip.warnings).toContain('latest explicit remember request produced no new active memory');
    expect(trip.warnings).toContain('1 workflow action(s) failed');
  });

  it('ignores ordinary agent groups without trip databases', () => {
    const groupsDir = path.join(tmp, 'groups');
    fs.mkdirSync(path.join(groupsDir, 'ordinary'), { recursive: true });
    expect(
      readTripCompanions(
        [{ id: 'ag-ordinary', name: 'Ordinary', folder: 'ordinary', model: null, provider: null, cli_scope: null, model_tiers: null }],
        { groupsDir, sessionsDir: path.join(tmp, 'sessions') },
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------- quota
describe('Claude subscription quota (statusline cache source)', () => {
  const writeCache = (obj: unknown, mtimeMs?: number): string => {
    const file = path.join(tmp, 'statusline-usage-cache.json');
    fs.writeFileSync(file, JSON.stringify(obj));
    if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  };

  it('parses 5h/7d utilization + reset times and computes freshness from mtime', () => {
    const now = 1_700_000_000_000;
    const file = writeCache(
      {
        five_hour: { utilization: 42, resets_at: '2026-06-11T20:00:00Z' },
        seven_day: { utilization: 7.5, resets_at: '2026-06-14T00:00:00Z' },
      },
      now - 30_000, // 30s old
    );
    const fresh = statuslineQuotaSource(file, 10 * 60_000, now);
    expect(fresh).not.toBeNull();
    expect(fresh!.fiveHourPct).toBe(42);
    expect(fresh!.sevenDayPct).toBe(7.5);
    expect(fresh!.fiveHourResetsAt).toBe('2026-06-11T20:00:00Z');
    expect(fresh!.fresh).toBe(true);
  });

  it('marks a stale cache not-fresh (so the collector can skip it)', () => {
    const now = 1_700_000_000_000;
    const file = writeCache({ five_hour: { utilization: 90 }, seven_day: { utilization: 30 } }, now - 20 * 60_000);
    const snap = statuslineQuotaSource(file, 10 * 60_000, now);
    expect(snap!.fresh).toBe(false);
    expect(snap!.fiveHourPct).toBe(90); // value still read; caller decides
  });

  it('treats 0% as a valid reading (not a missing value)', () => {
    const now = 1_700_000_000_000;
    const file = writeCache({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 } }, now);
    const snap = statuslineQuotaSource(file, 10 * 60_000, now);
    expect(snap!.fiveHourPct).toBe(0);
    expect(snap!.fresh).toBe(true);
  });

  it('returns null on missing file, bad JSON, or wrong shape', () => {
    const now = Date.now();
    expect(statuslineQuotaSource(path.join(tmp, 'nope.json'), 60_000, now)).toBeNull();
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    expect(statuslineQuotaSource(bad, 60_000, now)).toBeNull();
    const wrong = writeCache({ unrelated: true }, now);
    expect(statuslineQuotaSource(wrong, 60_000, now)).toBeNull();
  });

  it('readClaudeQuota reads the same cache for both sources', () => {
    const now = 1_700_000_000_000;
    const file = writeCache({ five_hour: { utilization: 12 }, seven_day: { utilization: 3 } }, now);
    expect(readClaudeQuota({ source: 'statusline', cacheFile: file, staleMs: 60_000 }, now)!.fiveHourPct).toBe(12);
    // fresh cache → 'oauth' returns the same snapshot without triggering a refresh
    expect(
      readClaudeQuota({ source: 'oauth', cacheFile: file, staleMs: 60_000, fetchTtlMs: 180_000 }, now)!.fiveHourPct,
    ).toBe(12);
  });
});

describe('Claude subscription quota (oauth read-through refresh)', () => {
  const writeCache = (obj: unknown, mtimeMs?: number): string => {
    const file = path.join(tmp, 'oauth-usage-cache.json');
    fs.writeFileSync(file, JSON.stringify(obj));
    if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  };
  const goodBody = JSON.stringify({
    five_hour: { utilization: 55, resets_at: '2026-06-12T20:00:00Z' },
    seven_day: { utilization: 33, resets_at: '2026-06-15T00:00:00Z' },
  });
  const deps = (token: string | null, body: string | null) => ({
    getToken: async () => token,
    fetchUsage: async () => body,
  });

  it('skips the fetch entirely while the cache is warm', () => {
    const now = 1_700_000_000_000;
    const file = writeCache({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }, now - 60_000);
    expect(maybeRefreshUsageCache(file, 180_000, now, deps('tok', goodBody))).toBeNull();
  });

  it('refreshes a stale cache atomically with the raw response', async () => {
    const now = 1_700_000_000_000;
    const file = writeCache({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }, now - 10 * 60_000);
    const p = maybeRefreshUsageCache(file, 180_000, now, deps('tok', goodBody));
    expect(p).not.toBeNull();
    expect(await p).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).five_hour.utilization).toBe(55);
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(now - 10 * 60_000 + 1);
  });

  it('creates the cache (and parent dir) when missing', async () => {
    const file = path.join(tmp, 'nested', 'fresh-cache.json');
    expect(await maybeRefreshUsageCache(file, 180_000, Date.now(), deps('tok', goodBody))).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).seven_day.utilization).toBe(33);
  });

  it('leaves the cache untouched on missing token, failed fetch, or bad body', async () => {
    const now = 1_700_000_000_000;
    const staleMtime = now - 10 * 60_000;
    const file = writeCache({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }, staleMtime);
    expect(await maybeRefreshUsageCache(file, 180_000, now, deps(null, goodBody))).toBe(false);
    expect(await maybeRefreshUsageCache(file, 180_000, now, deps('tok', null))).toBe(false);
    expect(await maybeRefreshUsageCache(file, 180_000, now, deps('tok', '{ not json'))).toBe(false);
    expect(await maybeRefreshUsageCache(file, 180_000, now, deps('tok', '{"unrelated":true}'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).five_hour.utilization).toBe(1);
    expect(Math.round(fs.statSync(file).mtimeMs)).toBe(staleMtime);
  });

  it('allows only one refresh in flight at a time', async () => {
    const now = 1_700_000_000_000;
    const file = writeCache({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }, now - 10 * 60_000);
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => (release = r));
    const slow = { getToken: async () => 'tok', fetchUsage: () => gate.then((b) => b) };
    const first = maybeRefreshUsageCache(file, 180_000, now, slow);
    expect(first).not.toBeNull();
    expect(maybeRefreshUsageCache(file, 180_000, now, deps('tok', goodBody))).toBeNull(); // in flight
    release(goodBody);
    expect(await first).toBe(true);
  });
});

describe('lifecycle line parsing', () => {
  it('extracts folder and epoch from container names', () => {
    expect(parseContainerName('nanoclaw-v2-test-group-1781255393012')).toEqual({
      folder: 'test-group',
      epochMs: 1781255393012,
    });
    expect(parseContainerName('nanoclaw-v2-group-42-1781255393012')).toEqual({
      folder: 'group-42',
      epochMs: 1781255393012,
    });
    expect(parseContainerName('not-a-container')).toBeNull();
    expect(parseContainerName('nanoclaw-v2-foo-123')).toBeNull(); // suffix must be 13-digit ms epoch
  });

  it('resolves a time-of-day clock just before an anchor, wrapping midnight', () => {
    // anchor: 2026-06-12T00:10:00 local. Clock 23:55 must land on June 11.
    const anchor = new Date(2026, 5, 12, 0, 10, 0).getTime();
    const ts = resolveClockBefore('23:55:00.000', anchor)!;
    expect(new Date(ts).getDate()).toBe(11);
    // Clock 00:05 stays on June 12.
    const ts2 = resolveClockBefore('00:05:00.000', anchor)!;
    expect(new Date(ts2).getDate()).toBe(12);
    expect(resolveClockBefore('garbage', anchor)).toBeNull();
  });

  it('resolves a clock at-or-after an anchor (backfill direction)', () => {
    // anchor (spawn): 2026-06-11T23:50 local. Exit clock 00:20 → June 12.
    const anchor = new Date(2026, 5, 11, 23, 50, 0).getTime();
    const ts = resolveClockAfter('00:20:00.000', anchor)!;
    expect(new Date(ts).getDate()).toBe(12);
    expect(ts).toBeGreaterThan(anchor);
  });

  it('parses spawn lines with exact epoch ts and exit lines with code', () => {
    const nowMs = Date.now();
    const spawn = parseLifecycleLine(
      '[14:39:53.078] INFO Spawning container sessionId="sess-abc" agentGroup="shyNano" containerName="nanoclaw-v2-test-group-1781255393012"',
      nowMs,
      'before',
    )!;
    expect(spawn.kind).toBe('container_spawn');
    expect(spawn.tsMs).toBe(1781255393012); // from name, not clock
    expect(spawn.folder).toBe('test-group');
    expect(spawn.sessionId).toBe('sess-abc');
    expect(spawn.code).toBeNull();

    const exit = parseLifecycleLine(
      '[15:20:13.572] INFO Container exited sessionId="sess-abc" code=137 containerName="nanoclaw-v2-test-group-1781255393012"',
      nowMs,
      'before',
    )!;
    expect(exit.kind).toBe('container_exit');
    expect(exit.code).toBe(137);
    expect(exit.tsMs).toBeLessThanOrEqual(nowMs + 60_000);

    expect(parseLifecycleLine('[15:20:13.572] INFO Message routed x=1', nowMs, 'before')).toBeNull();

    // "Killing container" is the reliable span-closer (the async "Container
    // exited" confirmation is best-effort and sometimes never logged). Parse it
    // as a kill-derived exit carrying the teardown reason and no OS code.
    const kill = parseLifecycleLine(
      '[15:20:13.000] INFO Killing container sessionId="s" reason="absolute-ceiling" containerName="nanoclaw-v2-foo-1781255393012"',
      nowMs,
      'before',
    )!;
    expect(kill.kind).toBe('container_exit');
    expect(kill.reason).toBe('absolute-ceiling');
    expect(kill.code).toBeNull();
    expect(kill.folder).toBe('foo');

    // A non-zero OS exit also closes the span (formerly unmatched → stranded).
    const nonZero = parseLifecycleLine(
      '[15:20:13.572] WARN Container exited non-zero sessionId="s" code=75 containerName="nanoclaw-v2-foo-1781255393012"',
      nowMs,
      'before',
    )!;
    expect(nonZero.kind).toBe('container_exit');
    expect(nonZero.code).toBe(75);
    expect(nonZero.reason).toBeNull();

    // …but host-sweep's pre-log WARN (no containerName) is still ignored.
    expect(
      parseLifecycleLine(
        '[15:20:13.000] WARN Killing container past absolute ceiling sessionId="s" heartbeatAgeMs=1805464 ceilingMs=1800000',
        nowMs,
        'before',
      ),
    ).toBeNull();
  });

  it('captures the wake trigger on spawn lines; exits carry no trigger', () => {
    const nowMs = Date.now();
    const spawn = parseLifecycleLine(
      '[14:39:53.078] INFO Spawning container sessionId="sess-abc" agentGroup="shyNano" containerName="nanoclaw-v2-test-group-1781255393012" trigger="telegram · telegram:42: can we build hooks"',
      nowMs,
      'before',
    )!;
    expect(spawn.trigger).toBe('telegram · telegram:42: can we build hooks');

    const noTrigger = parseLifecycleLine(
      '[14:39:53.078] INFO Spawning container sessionId="sess-abc" agentGroup="shyNano" containerName="nanoclaw-v2-test-group-1781255393012"',
      nowMs,
      'before',
    )!;
    expect(noTrigger.trigger).toBeNull();

    const exit = parseLifecycleLine(
      '[15:20:13.572] INFO Container exited sessionId="sess-abc" code=137 containerName="nanoclaw-v2-test-group-1781255393012" trigger="ignored"',
      nowMs,
      'before',
    )!;
    expect(exit.trigger).toBeNull(); // trigger is meaningful only for spawns
  });
});

describe('lifecycle ingest & backfill', () => {
  let db: Database.Database;
  let dir: string;
  const folderMap = new Map([['test-group', 'ag-1']]);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-lc-'));
    db = openOpsDb(path.join(dir, 'ops.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const SPAWN =
    '[14:39:53.078] INFO Spawning container sessionId="sess-abc" agentGroup="shyNano" containerName="nanoclaw-v2-test-group-1781255393012"';
  const EXIT =
    '[15:20:13.572] INFO Container exited sessionId="sess-abc" code=137 containerName="nanoclaw-v2-test-group-1781255393012"';

  it('ingests spawn/exit lines as events, skipping unknown folders', () => {
    const n = ingestLifecycleLines(
      db,
      [SPAWN, EXIT, SPAWN.replace('test-group', 'ghost-group')],
      folderMap,
      Date.now(),
    );
    expect(n).toBe(2);
    const rows = listEventsByKind(db, 'ag-1', ['container_spawn', 'container_exit'], '2020-01-01');
    expect(rows).toHaveLength(2);
    const spawn = rows.find((r) => r.kind === 'container_spawn')!;
    expect(spawn.ts).toBe(new Date(1781255393012).toISOString());
    const detail = JSON.parse(rows.find((r) => r.kind === 'container_exit')!.detail);
    expect(detail).toMatchObject({
      containerName: 'nanoclaw-v2-test-group-1781255393012',
      sessionId: 'sess-abc',
      code: 137,
    });
    expect(listEventsByKind(db, 'ag-1', [], '2020-01-01')).toEqual([]);
  });

  it('backfills the live log once, anchored monotonically, and seals the offset', () => {
    const logFile = path.join(dir, 'nanoclaw.log');
    fs.writeFileSync(logFile, `${SPAWN}\n${EXIT}\nnoise line\n`);
    expect(backfillLifecycle(db, logFile, folderMap, Date.now())).toBe(2);
    // second call is a no-op
    expect(backfillLifecycle(db, logFile, folderMap, Date.now())).toBe(0);
    // offset meta now set so the incremental scan won't re-ingest these bytes
    expect(Number(getMeta(db, `log:${logFile}`))).toBe(fs.statSync(logFile).size);
    // exit ts resolved AFTER the spawn epoch
    const rows = listEventsByKind(db, 'ag-1', ['container_exit'], '2020-01-01');
    expect(Date.parse(rows[0].ts)).toBeGreaterThan(1781255393012);
  });

  it('backfill respects an existing incremental offset (no double ingest of the tail)', () => {
    const logFile = path.join(dir, 'nanoclaw.log');
    fs.writeFileSync(logFile, `${SPAWN}\n`);
    const consumed = fs.statSync(logFile).size;
    fs.appendFileSync(logFile, `${EXIT}\n`);
    setMeta(db, `log:${logFile}`, String(consumed)); // incremental scan owns the appended exit line
    expect(backfillLifecycle(db, logFile, folderMap, Date.now())).toBe(1); // spawn only
  });

  it('lastActiveSampleMs returns the newest containers_up>0 sample', () => {
    insertSamples(db, [
      { ts: '2026-06-12T10:00:00.000Z', group_id: 'ag-1', metric: 'containers_up', value: 1 },
      { ts: '2026-06-12T10:01:00.000Z', group_id: 'ag-1', metric: 'containers_up', value: 1 },
    ]);
    expect(lastActiveSampleMs(db, 'ag-1', '2026-06-12T00:00:00.000Z')).toBe(Date.parse('2026-06-12T10:01:00.000Z'));
    expect(lastActiveSampleMs(db, 'ag-2', '2026-06-12T00:00:00.000Z')).toBeNull();
  });
});

describe('activity spans', () => {
  const NOW = Date.parse('2026-06-12T12:00:00.000Z');
  const FROM = NOW - 86_400_000;
  const row = (kind: string, tsMs: number, name: string, extra: Record<string, unknown> = {}) => ({
    ts: new Date(tsMs).toISOString(),
    group_id: 'ag-1',
    kind,
    severity: 'info',
    detail: JSON.stringify({ containerName: name, sessionId: 'sess-1', ...extra }),
  });
  const name = (epoch: number) => `nanoclaw-v2-grp-${epoch}`;

  it('pairs spawn/exit into closed spans', () => {
    const t0 = NOW - 3_600_000;
    const spans = buildSpans(
      [row('container_spawn', t0, name(t0)), row('container_exit', t0 + 600_000, name(t0), { code: 137 })],
      { fromMs: FROM, nowMs: NOW, containersUpNow: 0, lastActiveSampleMs: null },
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ startMs: t0, endMs: t0 + 600_000, live: false, approx: false, code: 137 });
  });

  it('recovers the start from the name epoch when the spawn event is outside the window', () => {
    const t0 = FROM - 3_600_000; // spawned 25h ago
    const spans = buildSpans([row('container_exit', FROM + 1_800_000, name(t0), { code: 0 })], {
      fromMs: FROM,
      nowMs: NOW,
      containersUpNow: 0,
      lastActiveSampleMs: null,
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].startMs).toBe(t0);
  });

  it('extends unclosed spans to now when a container is up, else approx-closes from samples', () => {
    const t0 = NOW - 1_800_000;
    const live = buildSpans([row('container_spawn', t0, name(t0))], {
      fromMs: FROM,
      nowMs: NOW,
      containersUpNow: 1,
      lastActiveSampleMs: null,
    });
    expect(live[0]).toMatchObject({ endMs: NOW, live: true, approx: false });

    const lastSeen = NOW - 600_000;
    const orphan = buildSpans([row('container_spawn', t0, name(t0))], {
      fromMs: FROM,
      nowMs: NOW,
      containersUpNow: 0,
      lastActiveSampleMs: lastSeen,
    });
    expect(orphan[0]).toMatchObject({ endMs: lastSeen, live: false, approx: true });

    const noSamples = buildSpans([row('container_spawn', t0, name(t0))], {
      fromMs: FROM,
      nowMs: NOW,
      containersUpNow: 0,
      lastActiveSampleMs: null,
    });
    expect(noSamples[0].endMs).toBe(t0); // zero-length, still renders a sliver
  });

  it('bounds an orphan approx-close at the next container spawn', () => {
    const t0 = NOW - 7_200_000; // orphan: spawned 2h ago, no exit
    const t1 = NOW - 3_600_000; // next container spawned 1h ago
    const spans = buildSpans(
      [row('container_spawn', t0, name(t0)), row('container_spawn', t1, name(t1), { code: undefined })],
      // lastActiveSampleMs is ~now, which would otherwise stretch the orphan across the window
      { fromMs: FROM, nowMs: NOW, containersUpNow: 0, lastActiveSampleMs: NOW - 60_000 },
    );
    const orphan = spans.find((s) => s.startMs === t0)!;
    expect(orphan.endMs).toBe(t1); // capped at next spawn, not the last active sample
    expect(orphan.approx).toBe(true);
  });

  it('closes a span at a kill-derived exit instead of stretching to the next spawn', () => {
    // Regression for the phantom "longest 5.6h": a container killed 30m after
    // spawn, whose async "Container exited" line never landed, used to stay
    // open and stretch across the dormant gap to the next spawn hours later —
    // swallowing the idle time into "active". The kill event (container_exit,
    // reason set, no code) now closes it at the kill instant.
    const t0 = NOW - 6 * 3_600_000; // spawned 6h ago
    const killMs = t0 + 1_800_000; // killed 30m later
    const t1 = NOW - 30_000; // next spawn ~now, after a 5.5h dormant gap
    const spans = buildSpans(
      [
        row('container_spawn', t0, name(t0)),
        row('container_exit', killMs, name(t0), { reason: 'absolute-ceiling' }),
        row('container_spawn', t1, name(t1)),
      ],
      { fromMs: FROM, nowMs: NOW, containersUpNow: 0, lastActiveSampleMs: NOW - 60_000 },
    );
    const killed = spans.find((s) => s.startMs === t0)!;
    expect(killed.endMs).toBe(killMs); // NOT stretched to t1
    expect(killed.approx).toBe(false);
  });

  it('ends a span at the earliest close when both a kill and an exit are recorded', () => {
    const t0 = NOW - 3_600_000;
    const killMs = t0 + 1_800_000;
    const exitMs = killMs + 1_200; // async confirmation ~1s after the kill
    const spans = buildSpans(
      [
        row('container_spawn', t0, name(t0)),
        row('container_exit', exitMs, name(t0), { code: 137 }), // out of order on purpose
        row('container_exit', killMs, name(t0), { reason: 'claim-stuck' }),
      ],
      { fromMs: FROM, nowMs: NOW, containersUpNow: 0, lastActiveSampleMs: null },
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].endMs).toBe(killMs); // earliest close wins
    expect(spans[0].code).toBe(137); // OS code still captured from the exit row
  });

  it('drops spans that ended before the window', () => {
    const t0 = FROM - 7_200_000;
    const spans = buildSpans(
      [row('container_spawn', t0, name(t0)), row('container_exit', t0 + 60_000, name(t0), { code: 0 })],
      { fromMs: FROM, nowMs: NOW, containersUpNow: 0, lastActiveSampleMs: null },
    );
    expect(spans).toHaveLength(0);
  });

  it('unionDurationMs merges overlapping spans', () => {
    const mk = (s: number, e: number) => ({
      startMs: s,
      endMs: e,
      live: false,
      approx: false,
      sessionId: null,
      code: null,
      containerName: 'x',
    });
    // two overlapping 20-min spans covering 30 min total
    const total = unionDurationMs([mk(FROM, FROM + 1_200_000), mk(FROM + 600_000, FROM + 1_800_000)], FROM, NOW);
    expect(total).toBe(1_800_000);
  });
});

describe('activity ribbon svg', () => {
  const NOW = Date.parse('2026-06-12T12:00:00.000Z');
  const span = (s: number, e: number, over: Partial<import('./readers/lifecycle.js').ActivitySpan> = {}) => ({
    startMs: s,
    endMs: e,
    live: false,
    approx: false,
    sessionId: 'sess-1',
    code: 137,
    containerName: 'c',
    ...over,
  });

  it('renders one segment per span, ticks per subagent, and summary stats', () => {
    const spans = [span(NOW - 3_600_000, NOW - 3_000_000), span(NOW - 600_000, NOW, { live: true, code: null })];
    const svg = activityRibbon(spans, [{ tsMs: NOW - 3_300_000, model: 'haiku' }], { nowMs: NOW });
    expect(svg.match(/<rect class="rb-/g)).toHaveLength(2);
    expect(svg).toContain('rb-live');
    expect(svg).toContain('rb-tick');
    expect(svg).toContain('exit 137');
    expect(ribbonStat(spans, NOW)).toContain('2 spawns');
  });

  it('renders an empty-state baseline with no spans', () => {
    const svg = activityRibbon([], [], { nowMs: NOW });
    expect(svg).not.toContain('rb-on');
    expect(ribbonStat([], NOW)).toContain('0 spawns');
  });
});

describe('model mix line', () => {
  it('renders per-model chips with sub counts and lane labels', () => {
    const html = modelMixLine([
      { model: 'claude-sonnet-4-6', out: 168_800, subOut: 0, subSpawns: 0 },
      { model: 'claude-haiku-4-5-20251001', out: 12_000, subOut: 12_000, subSpawns: 3 },
      { model: 'claude-opus-4-8', out: 2_000, subOut: 2_000, subSpawns: 1 },
    ]);
    expect(html).toContain('sonnet-4-6');
    expect(html).toContain('main');
    expect(html).toContain('3 subs');
    expect(html).toContain('1 sub');
  });

  it('renders a quiet placeholder with no data', () => {
    expect(modelMixLine([])).toContain('–');
  });
});

describe('prettyHandle', () => {
  it('strips the channel prefix and platform JID noise', () => {
    expect(prettyHandle('whatsapp:915550000003@s.whatsapp.net')).toBe('915550000003');
    expect(prettyHandle('whatsapp:111000000000003@lid')).toBe('111000000000003');
    expect(prettyHandle('telegram:5550001111')).toBe('5550001111');
    expect(prettyHandle('cli:alice')).toBe('alice');
  });
});

describe('allowlistCard', () => {
  const member = (user_id: string, display_name: string | null): MemberInfo => {
    const i = user_id.indexOf(':');
    const channel = i > 0 ? user_id.slice(0, i) : '';
    return { user_id, channel, display_name, kind: channel };
  };

  it('groups members by channel and shows names, bare handles, and counts', () => {
    const html = allowlistCard(
      [
        member('whatsapp:915550000003@s.whatsapp.net', 'Grace H'),
        member('whatsapp:915550000001@s.whatsapp.net', 'Alice A'),
        member('telegram:5550001111', 'Operator'),
      ],
      ['whatsapp', 'telegram'],
    );
    expect(html).toContain('Allowlist');
    expect(html).toContain('Grace H');
    expect(html).toContain('915550000003'); // bare handle, JID suffix stripped
    expect(html).not.toContain('@s.whatsapp.net');
    expect(html).toContain('whatsapp <b>2</b>');
    expect(html).toContain('telegram <b>1</b>'); // generalizes beyond WhatsApp
  });

  it('excludes internal cli/agent transports from the allowlist', () => {
    const html = allowlistCard(
      [member('whatsapp:915550000003@s.whatsapp.net', 'Grace'), member('cli:alice', 'Alice')],
      ['whatsapp'],
    );
    expect(html).toContain('Grace');
    expect(html).not.toContain('cli');
    expect(html).not.toContain('Alice');
  });

  it('surfaces a connected channel that has an empty allowlist (everyone ignored)', () => {
    const html = allowlistCard([], ['telegram']);
    expect(html).toContain('telegram <b>0</b>');
    expect(html).toContain('every telegram sender is treated as unknown');
  });

  it('renders a neutral placeholder when no chat channel is connected', () => {
    expect(allowlistCard([], [])).toContain('No chat channel connected');
  });
});

// ---------------------------------------------------------------- skills
describe('skills catalog reader', () => {
  const writeSkill = (root: string, id: string, md: string | null) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    if (md !== null) fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  };

  it('lists skill roots, parses inline + folded frontmatter, falls back to id, skips files and namespaces', () => {
    writeSkill(tmp, 'trip-finance', '---\nname: trip-finance\ndescription: Track and split shared trip expenses.\n---\n# body');
    writeSkill(
      tmp,
      'onecli-gateway',
      '---\nname: onecli-gateway\ndescription: >-\n  OneCLI Gateway: transparent HTTPS proxy that injects\n  stored credentials into outbound calls.\n---\n# body',
    );
    writeSkill(tmp, 'memory', null); // no SKILL.md, but still a skill because it has instructions.md
    fs.writeFileSync(path.join(tmp, 'memory', 'instructions.md'), 'memory rules');
    fs.mkdirSync(path.join(tmp, 'trip-companion-skills'), { recursive: true }); // namespace, not a skill
    fs.writeFileSync(path.join(tmp, 'not-a-dir.txt'), 'ignore me');

    const skills = listAvailableSkills(tmp);
    expect(skills.map((s) => s.id)).toEqual(['memory', 'onecli-gateway', 'trip-finance']); // sorted; file excluded
    const fin = skills.find((s) => s.id === 'trip-finance')!;
    expect(fin.name).toBe('trip-finance');
    expect(fin.description).toBe('Track and split shared trip expenses.');
    const gw = skills.find((s) => s.id === 'onecli-gateway')!;
    expect(gw.description).toBe(
      'OneCLI Gateway: transparent HTTPS proxy that injects stored credentials into outbound calls.',
    );
    const mem = skills.find((s) => s.id === 'memory')!;
    expect(mem.name).toBe('memory'); // id fallback when SKILL.md is absent
    expect(mem.description).toBe('');
  });

  it('returns an empty array for a missing directory', () => {
    expect(listAvailableSkills(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('matches the real shared catalog (smoke): finds onecli-gateway with a description', () => {
    const real = listAvailableSkills(); // default PATHS.containerSkillsDir
    expect(real.length).toBeGreaterThan(0);
    const gw = real.find((s) => s.id === 'onecli-gateway');
    expect(gw).toBeDefined();
    expect(gw!.description.length).toBeGreaterThan(0);
    expect(real.some((s) => s.id === 'trip-companion-skills')).toBe(false);
  });
});

describe('resolveGroupSkills', () => {
  const cat: SkillInfo[] = [
    { id: 'a', name: 'a', description: '' },
    { id: 'b', name: 'b', description: '' },
    { id: 'c', name: 'c', description: '' },
  ];

  it('treats null / "all" / unparseable as every available skill (dynamic)', () => {
    for (const col of [null, '"all"', 'not json', '{"x":1}']) {
      const r = resolveGroupSkills(col, cat);
      expect(r.mode).toBe('all');
      expect([...r.enabledIds].sort()).toEqual(['a', 'b', 'c']);
    }
  });

  it('treats an array as an explicit selection, intersected with the catalog', () => {
    const r = resolveGroupSkills('["a","c","stale"]', cat);
    expect(r.mode).toBe('list');
    expect([...r.enabledIds].sort()).toEqual(['a', 'c']); // 'stale' dropped — not on disk
  });

  it('an empty array enables nothing', () => {
    const r = resolveGroupSkills('[]', cat);
    expect(r.mode).toBe('list');
    expect(r.enabledIds.size).toBe(0);
  });
});

describe('skillsLine — per-card summary (Part 1)', () => {
  it('shows "all (N)" in all-mode', () => {
    const html = skillsLine({ mode: 'all', enabledIds: [], total: 18 });
    expect(html).toContain('skills <b>all</b>');
    expect(html).toContain('(18)');
  });

  it('shows count and the first five names in list-mode, truncating the rest', () => {
    const ids = ['trip-core', 'trip-finance', 'trip-docs', 'memory', 'welcome', 'agent-browser', 'vercel-cli'];
    const html = skillsLine({ mode: 'list', enabledIds: ids, total: 18 });
    expect(html).toContain('<b>7</b>');
    expect(html).toContain('/18');
    expect(html).toContain('trip-core, trip-finance, trip-docs, memory, welcome');
    expect(html).toContain('+2'); // 7 enabled, 5 shown
    expect(html).not.toContain('agent-browser'); // beyond the first five
  });
});

describe('skillsCard — interactive detail panel (Part 2)', () => {
  const cat: SkillInfo[] = [
    { id: 'trip-finance', name: 'trip-finance', description: 'Track and split shared trip expenses.' },
    { id: 'onecli-gateway', name: 'onecli-gateway', description: 'Credential proxy.' },
    { id: 'agent-browser', name: 'agent-browser', description: 'Headless browser.' },
  ];

  it('checks every skill in all-mode, notes auto-inclusion, badges core skills, wires Apply', () => {
    const html = skillsCard('ag-x', 'X', cat, resolveGroupSkills('"all"', cat));
    expect(html).toContain('Skills <span class="muted small">3/3');
    expect(html).toContain('all 3');
    expect(html).toContain('included automatically');
    expect((html.match(/class="skl"/g) ?? []).length).toBe(3); // a checkbox per skill
    expect((html.match(/class="skl"[^>]* checked/g) ?? []).length).toBe(3); // all checked
    expect(html).toContain('>core<'); // onecli-gateway badge
    expect(html).toContain('Apply &amp; restart');
    expect(html).toContain("document.querySelectorAll('#skills-ag-x input.skl:checked')");
  });

  it('checks only the selection in list-mode, enabled sorts first', () => {
    const html = skillsCard('ag-y', 'Y', cat, resolveGroupSkills('["trip-finance"]', cat));
    expect(html).toContain('1/3');
    expect(html).toContain('Explicit selection');
    expect((html.match(/class="skl"[^>]* checked/g) ?? []).length).toBe(1); // only the selection checked
    expect(html.indexOf('trip-finance')).toBeLessThan(html.indexOf('agent-browser')); // enabled sorts first
  });

  it('escapes descriptions/name, strips apostrophes from the confirm, appends the footer', () => {
    const evil: SkillInfo[] = [{ id: 'x', name: 'x', description: '<script>alert(1)</script>' }];
    const html = skillsCard('ag-z', "Bob's", evil, resolveGroupSkills('"all"', evil), '<div id="cstat-footer">hi</div>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<div id="cstat-footer">hi</div>');
    expect(html).toContain('Bobs and restart'); // apostrophe stripped so the JS string stays intact
    expect(html).not.toContain("Bob's and restart");
  });

  it('renders a placeholder when the catalog is empty, still keeping the footer', () => {
    const html = skillsCard('ag-e', 'E', [], resolveGroupSkills('"all"', []), '<div id="f"></div>');
    expect(html).toContain('No shared skills found');
    expect(html).toContain('<div id="f"></div>');
  });
});

describe('planSkillsUpdate — validate + decide what to persist', () => {
  const cat: SkillInfo[] = [
    { id: 'a', name: 'a', description: '' },
    { id: 'b', name: 'b', description: '' },
    { id: 'onecli-gateway', name: 'onecli-gateway', description: '' },
  ];

  it('collapses a full selection back to dynamic "all"', () => {
    expect(planSkillsUpdate(['a', 'b', 'onecli-gateway'], cat)).toEqual({ ok: true, value: 'all' });
  });

  it('writes a sorted, deduped explicit array for a subset', () => {
    expect(planSkillsUpdate(['b', 'b', 'a'], cat)).toEqual({ ok: true, value: ['a', 'b'] });
  });

  it('allows an empty selection (a group may run with no skills)', () => {
    expect(planSkillsUpdate([], cat)).toEqual({ ok: true, value: [] });
  });

  it('rejects unknown skills (which would only dangle)', () => {
    const r = planSkillsUpdate(['a', 'ghost'], cat);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ghost');
  });

  it('does NOT force-add or reject when a core skill is absent (informational only)', () => {
    expect(planSkillsUpdate(['a'], cat)).toEqual({ ok: true, value: ['a'] }); // onecli-gateway omitted, allowed
  });
});

describe('isCore', () => {
  it('flags onecli-gateway as core, others not', () => {
    expect(isCore('onecli-gateway')).toBe(true);
    expect(isCore('trip-finance')).toBe(false);
  });
});

describe('senderKey — canonical <channel>:<handle> id', () => {
  it('prefixes a bare handle with its channel', () => {
    expect(senderKey('whatsapp', '915550000003@s.whatsapp.net')).toBe('whatsapp:915550000003@s.whatsapp.net');
    expect(senderKey('telegram', '5550001111')).toBe('telegram:5550001111');
  });
  it('passes an already-prefixed sender through unchanged (no double prefix)', () => {
    expect(senderKey('telegram', 'telegram:5550001111')).toBe('telegram:5550001111');
    expect(senderKey('cli', 'cli:alice')).toBe('cli:alice');
  });
  it('treats a null/absent channel as an empty prefix', () => {
    expect(senderKey(null, 'unknown')).toBe(':unknown');
  });
});

describe('quota chart svg', () => {
  const NOW = Date.parse('2026-06-19T08:30:00.000Z');
  const cur = (over: Record<string, unknown> = {}) => ({
    fiveHourPct: 11,
    sevenDayPct: 16,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    ageMs: 13_000,
    fresh: true,
    ...over,
  });

  it('ends the line at the live current value, not a stale trailing sample', () => {
    // The persisted series froze at an old reading during a stale gap (16% / 22%),
    // but the live cache has since moved on to 11% / 16%. The end-of-line labels
    // must reflect the current reading shown in the header, not the stale samples.
    const fiveH = [{ t: '2026-06-18T13:51:00.000Z', value: 16 }];
    const sevenD = [{ t: '2026-06-18T13:51:00.000Z', value: 22 }];
    const svg = quotaChart(fiveH, sevenD, { current: cur(), nowMs: NOW });
    expect(svg).toContain('>11%</text>');
    expect(svg).toContain('>16%</text>');
    expect(svg).not.toContain('>22%</text>');
  });

  it('keeps the latest sample when it is newer than the live snapshot', () => {
    // Sample taken at NOW; cur's cache is 13s stale, so the sample is newer and
    // must not be clobbered by an older current reading.
    const svg = quotaChart(
      [{ t: '2026-06-19T08:30:00.000Z', value: 12 }],
      [{ t: '2026-06-19T08:30:00.000Z', value: 17 }],
      { current: cur(), nowMs: NOW },
    );
    expect(svg).toContain('>12%</text>');
    expect(svg).toContain('>17%</text>');
  });
});

describe('routing decisions', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-rd-'));
    const db = new Database(path.join(dir, 'outbound.db'));
    db.exec(`CREATE TABLE messages_out (
      id TEXT, seq INTEGER, in_reply_to TEXT, timestamp TEXT NOT NULL, deliver_after TEXT,
      recurrence TEXT, kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
    )`);
    const ins = db.prepare("INSERT INTO messages_out (timestamp, kind, content) VALUES (?, 'chat', ?)");
    ins.run('2026-06-12T10:00:00.000Z', JSON.stringify({ text: 'Done.\n\n[haiku — web search errand]' }));
    ins.run(
      '2026-06-12T10:05:00.000Z',
      JSON.stringify({ text: 'Refactor complete. [opus — complex multi-file refactor]' }),
    );
    ins.run('2026-06-12T10:06:00.000Z', JSON.stringify({ text: 'plain reply, no routing line' }));
    ins.run('2026-06-12T10:07:00.000Z', JSON.stringify({ text: 'array notation [0] is not a routing line' }));
    db.close();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('extracts model + reason, newest first, ignoring lookalikes', () => {
    const out = readRoutingDecisions(dir, '2026-06-12T00:00:00.000Z');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ model: 'opus', reason: 'complex multi-file refactor', source: 'line' });
    expect(out[1]).toMatchObject({ model: 'haiku', reason: 'web search errand', source: 'line' });
  });

  it('returns [] when outbound.db is missing', () => {
    expect(readRoutingDecisions(path.join(dir, 'nope'), '2026-06-12T00:00:00.000Z')).toEqual([]);
  });

  it('includes zone-less SQLite-datetime rows after an ISO since (T-vs-space regression)', () => {
    // A real outbound.db stores 'YYYY-MM-DD HH:MM:SS' (space, no zone). The since
    // bound is an ISO 'T...Z' string; a naive SQL string compare wrongly drops it.
    const db2 = new Database(path.join(dir, 'outbound.db'));
    db2
      .prepare("INSERT INTO messages_out (timestamp, kind, content) VALUES (?, 'chat', ?)")
      .run('2026-06-12 11:00:00', JSON.stringify({ text: 'later. [sonnet — deep research]' }));
    db2.close();
    const out = readRoutingDecisions(dir, '2026-06-12T09:00:00.000Z');
    expect(out.some((d) => d.model === 'sonnet' && d.reason === 'deep research')).toBe(true);
  });
});

describe('modelFamily', () => {
  it('collapses full and short model ids to a tier family', () => {
    expect(modelFamily('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelFamily('opus')).toBe('opus');
  });
  it('passes through unknown ids unchanged', () => {
    expect(modelFamily('gpt-4o')).toBe('gpt-4o');
  });
});

describe('mergeRoutingDecisions', () => {
  it('keeps a spawn with no nearby line, tagged source=spawn with a neutral reason', () => {
    const out = mergeRoutingDecisions(
      [{ ts: '2026-06-14T12:20:02.444Z', model: 'claude-sonnet-4-6', file: 'agent-abc.jsonl' }],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      model: 'sonnet',
      reason: 'subagent spawned',
      source: 'spawn',
      file: 'agent-abc.jsonl',
    });
  });

  it('lends a same-tier text line reason to a nearby spawn (one row, not two)', () => {
    const out = mergeRoutingDecisions(
      [{ ts: '2026-06-14T12:20:02.000Z', model: 'claude-sonnet-4-6', file: 'agent-abc.jsonl' }],
      [{ ts: '2026-06-14 12:20:40', model: 'sonnet', reason: 'scotland research', source: 'line' }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ model: 'sonnet', reason: 'scotland research', source: 'spawn' });
  });

  it('does not match a line of a different tier or outside the window', () => {
    const out = mergeRoutingDecisions(
      [{ ts: '2026-06-14T12:20:02.000Z', model: 'claude-sonnet-4-6' }],
      [
        { ts: '2026-06-14 12:20:10', model: 'opus', reason: 'wrong tier', source: 'line' },
        { ts: '2026-06-14 12:30:02', model: 'sonnet', reason: 'too far away', source: 'line' },
      ],
    );
    // spawn stays neutral; both unmatched lines survive on their own → 3 rows
    expect(out).toHaveLength(3);
    expect(out.find((d) => d.source === 'spawn')?.reason).toBe('subagent spawned');
    expect(out.filter((d) => d.source === 'line')).toHaveLength(2);
  });

  it('sorts newest-first across ISO spawns and zone-less line timestamps', () => {
    const out = mergeRoutingDecisions(
      [{ ts: '2026-06-14T10:49:36.000Z', model: 'claude-sonnet-4-6' }],
      [{ ts: '2026-06-14 12:28:10', model: 'haiku', reason: 'errand', source: 'line' }],
    );
    expect(out.map((d) => d.model)).toEqual(['haiku', 'sonnet']);
    expect(out.every((d) => d.ts.endsWith('Z'))).toBe(true);
  });

  it("uses the spawn's own transcript reason as the primary source", () => {
    const out = mergeRoutingDecisions(
      [{ ts: '2026-06-14T12:20:02.000Z', model: 'claude-haiku-4-5', file: 'agent-abc.jsonl', reason: 'Triage AI section' }],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ model: 'haiku', reason: 'Triage AI section', source: 'spawn' });
  });

  it("prefers the spawn's transcript reason over a nearby text line, and consumes that line (one row)", () => {
    const out = mergeRoutingDecisions(
      [{ ts: '2026-06-14T12:20:02.000Z', model: 'claude-sonnet-4-6', reason: 'crisp description' }],
      [{ ts: '2026-06-14 12:20:10', model: 'sonnet', reason: 'stale line reason', source: 'line' }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reason: 'crisp description', source: 'spawn' });
  });
});

describe('describeEvent — plain-English event summaries', () => {
  it('summarizes container lifecycle from JSON detail', () => {
    expect(
      describeEvent('container_spawn', '{"containerName":"nanoclaw-v2-x","sessionId":"sess-1700000000000-aaaaaa"}'),
    ).toBe('Container started · …aaaaaa');
    expect(describeEvent('container_exit', '{"code":137,"sessionId":"sess-1700000000000-aaaaaa"}')).toBe(
      'Container exited · SIGKILL · …aaaaaa',
    );
    expect(describeEvent('container_exit', '{"code":0,"sessionId":"sess-zzz"}')).toContain('clean exit');
  });

  it('appends the wake trigger to a container_spawn summary when present', () => {
    expect(
      describeEvent(
        'container_spawn',
        '{"containerName":"nanoclaw-v2-x","sessionId":"sess-1700000000000-aaaaaa","trigger":"telegram · telegram:42: build hooks"}',
      ),
    ).toBe('Container started · …aaaaaa — telegram · telegram:42: build hooks');
  });

  it('describes subagent_spawn with model family + reason (and gracefully without a reason)', () => {
    expect(
      describeEvent('subagent_spawn', '{"model":"claude-haiku-4-5-20251001","reason":"Triage Markets section"}'),
    ).toBe('Subagent haiku — Triage Markets section');
    // legacy event with no reason on disk → still readable, no longer "—"
    expect(describeEvent('subagent_spawn', '{"model":"claude-haiku-4-5-20251001"}')).toBe('Subagent spawned (haiku)');
  });

  it('parses kill log lines, including quoted reason values', () => {
    expect(
      describeEvent(
        'container_kill',
        '[07:32:53.454] WARN Killing container past absolute ceiling heartbeatAgeMs=2350462 ceilingMs=1800000',
      ),
    ).toBe('Killed — heartbeat idle 39m, past 30m ceiling');
    expect(
      describeEvent(
        'container_kill',
        '[07:32:53.454] WARN Killing container past absolute ceiling idleAgeMs=2350462 idleSource="host-activity" ceilingMs=1800000',
      ),
    ).toBe('Killed — host activity idle 39m, past 30m ceiling');
    expect(
      describeEvent('container_kill', '[07:32:53.456] INFO Killing container sessionId="s1" reason="absolute-ceiling"'),
    ).toBe('Killing container (absolute-ceiling)');
    expect(describeEvent('container_kill', 'INFO Cleared orphan processing claims cleared=2 reason="x"')).toBe(
      'Cleared 2 orphan processing claim(s)',
    );
    expect(describeEvent('container_kill', 'INFO Reset stale message with backoff tries=0 backoffMs=5000')).toBe(
      'Stale message reset · try 0, retry in 5s',
    );
  });

  it('passes through human text and tags operator actions; returns "" for unknown kinds', () => {
    expect(describeEvent('alert_sent', '5 container kills in the last 30 min')).toBe(
      '5 container kills in the last 30 min',
    );
    expect(describeEvent('action:/api/backup', '')).toBe('Operator action: /api/backup');
    expect(describeEvent('mystery_kind', 'whatever')).toBe('');
  });
});

describe('fmtTs / fmtDate — local-time rendering of stored UTC', () => {
  // TZ-independent invariant: a zone-less SQLite datetime('now') value is UTC, so it
  // must render identically to the same instant written as an ISO `Z` string. If
  // zone-less were (incorrectly) treated as local, these would differ by the offset.
  it('treats zone-less timestamps as UTC, matching the ISO Z form', () => {
    expect(fmtTs('2026-06-13 00:34:48')).toBe(fmtTs('2026-06-13T00:34:48.000Z'));
    expect(fmtDate('2026-06-13 00:34:48')).toBe(fmtDate('2026-06-13T00:34:48.000Z'));
  });

  it('handles null and unparseable input without throwing', () => {
    expect(fmtTs(null)).toBe('–');
    expect(fmtDate(undefined)).toBe('–');
    expect(fmtTs('not-a-date')).toBe('not-a-date');
  });
});
