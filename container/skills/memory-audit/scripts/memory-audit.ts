#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';

import { openMemoryDb } from '../../memory/scripts/db';
import { loadConfig } from '../../memory/scripts/config';
import { recall } from '../../memory/scripts/store';

type Status = 'pass' | 'warn' | 'fail';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(['json']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? 'health', positional: positional.slice(1), flags };
}

function str(flags: Args['flags'], key: string): string | undefined {
  return typeof flags[key] === 'string' ? (flags[key] as string) : undefined;
}

function hours(flags: Args['flags'], key: string, fallback: number): number {
  const raw = str(flags, key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readJson(path: string | undefined): unknown {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function tableExists(db: Database, table: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=$t").get({ $t: table });
}

function one<T>(db: Database, sql: string, params: Record<string, unknown> = {}): T | null {
  try {
    return db.query(sql).get(params) as T | null;
  } catch {
    return null;
  }
}

function all<T>(db: Database, sql: string, params: Record<string, unknown> = {}): T[] {
  try {
    return db.query(sql).all(params) as T[];
  } catch {
    return [];
  }
}

function statusFromIssues(issues: { severity: Status }[]): Status {
  if (issues.some((i) => i.severity === 'fail')) return 'fail';
  if (issues.some((i) => i.severity === 'warn')) return 'warn';
  return 'pass';
}

function redactContent(content: string | null | undefined, max = 220): string {
  const s = (content ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function health(flags: Args['flags']) {
  const dbPath = str(flags, 'db') ?? '/workspace/agent/memory.db';
  const configPath = str(flags, 'config') ?? '/workspace/agent/memory.config.json';
  const inboundPath = str(flags, 'inbound') ?? (existsSync('/workspace/inbound.db') ? '/workspace/inbound.db' : undefined);
  const conversationDir = str(flags, 'conversations') ?? path.join(path.dirname(dbPath), 'conversations');
  const cfg = readJson(configPath) as Record<string, any> | null;
  const issues: { severity: Status; code: string; message: string }[] = [];

  if (!existsSync(configPath)) issues.push({ severity: 'warn', code: 'config_missing', message: `config not found: ${configPath}` });
  if (!existsSync(dbPath)) {
    issues.push({ severity: 'fail', code: 'db_missing', message: `memory DB not found: ${dbPath}` });
    return {
      status: statusFromIssues(issues),
      dbPath,
      configPath,
      scope: cfg?.scope ?? null,
      issues,
    };
  }

  const db = new Database(dbPath, { readonly: true });
  const owner = tableExists(db, 'meta') ? one<{ v: string }>(db, "SELECT v FROM meta WHERE k='owner_id'")?.v ?? null : null;
  const approvalRequired = cfg?.approval?.required === true;
  const configuredOwner = typeof cfg?.approval?.owner === 'string' ? cfg.approval.owner : null;

  if (approvalRequired && !configuredOwner && !owner) {
    issues.push({
      severity: 'fail',
      code: 'approval_owner_missing',
      message: 'approval.required is true but neither memory.config.json nor meta.owner_id names an owner',
    });
  } else if (approvalRequired && configuredOwner && owner && configuredOwner !== owner) {
    issues.push({
      severity: 'warn',
      code: 'approval_owner_mismatch',
      message: `configured owner (${configuredOwner}) differs from meta.owner_id (${owner})`,
    });
  } else if (approvalRequired && configuredOwner && !owner) {
    issues.push({
      severity: 'warn',
      code: 'approval_owner_not_materialized',
      message: `configured owner (${configuredOwner}) is not yet materialized into meta.owner_id`,
    });
  }

  if (cfg?.reflection?.cadence === 'manual') {
    issues.push({
      severity: 'warn',
      code: 'reflection_manual',
      message: 'memory.config.json says reflection cadence is manual; a scheduled review task must exist separately',
    });
  }

  const totals = tableExists(db, 'memories')
    ? {
        total: one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM memories')?.c ?? 0,
        active: one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM memories WHERE status='active'")?.c ?? 0,
        pending: one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM memories WHERE status='pending'")?.c ?? 0,
        rejected: one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM memories WHERE status='rejected'")?.c ?? 0,
      }
    : { total: 0, active: 0, pending: 0, rejected: 0 };
  const categories = tableExists(db, 'memories')
    ? all<{ category: string; c: number }>(db, "SELECT category, COUNT(*) AS c FROM memories WHERE status='active' GROUP BY category ORDER BY c DESC")
    : [];
  const access = tableExists(db, 'memories')
    ? one<{ totalAccess: number; usedRows: number; neverUsedRows: number }>(
        db,
        "SELECT COALESCE(SUM(access_count),0) AS totalAccess, SUM(CASE WHEN access_count > 0 THEN 1 ELSE 0 END) AS usedRows, SUM(CASE WHEN status='active' AND access_count = 0 THEN 1 ELSE 0 END) AS neverUsedRows FROM memories",
      )
    : null;
  if (totals.active > 0 && (access?.usedRows ?? 0) === 0) {
    issues.push({ severity: 'warn', code: 'no_reinforced_recalls', message: 'active memories exist but no row has access_count > 0' });
  }

  const eventStats = tableExists(db, 'memory_events')
    ? {
        total: one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM memory_events')?.c ?? 0,
        byOp: all<{ op: string; c: number; lastAt: string }>(
          db,
          'SELECT op, COUNT(*) AS c, MAX(at) AS lastAt FROM memory_events GROUP BY op ORDER BY lastAt DESC',
        ),
        recall: one<{ calls: number; misses: number; hits: number; lastAt: string | null }>(
          db,
          "SELECT COUNT(*) AS calls, SUM(CASE WHEN COALESCE(hit_count,0)=0 THEN 1 ELSE 0 END) AS misses, SUM(CASE WHEN COALESCE(hit_count,0)>0 THEN 1 ELSE 0 END) AS hits, MAX(at) AS lastAt FROM memory_events WHERE op='recall'",
        ),
      }
    : { total: 0, byOp: [], recall: null };
  if ((eventStats.recall?.calls ?? 0) === 0 && totals.active > 0) {
    issues.push({ severity: 'warn', code: 'no_recall_events', message: 'active memories exist but no recall events are logged' });
  }

  const recallWindowHours = hours(flags, 'since-hours', 24);
  const lastRecallAt = eventStats.recall?.lastAt ?? null;
  if (totals.active > 0 && eventStats.recall?.calls && lastRecallAt) {
    const lastRecallMs = Date.parse(lastRecallAt);
    if (Number.isFinite(lastRecallMs) && Date.now() - lastRecallMs > recallWindowHours * 60 * 60 * 1000) {
      issues.push({
        severity: 'warn',
        code: 'stale_recall_events',
        message: `the last recorded recall was more than ${recallWindowHours} hour(s) ago (${lastRecallAt})`,
      });
    }
  }

  let schedules: unknown[] = [];
  let reviewEvidence: Record<string, unknown> | null = null;
  if (inboundPath && existsSync(inboundPath)) {
    const inbound = new Database(inboundPath, { readonly: true });
    if (tableExists(inbound, 'messages_in')) {
      const reviewSinceHours = hours(flags, 'since-hours', 24);
      const reviewCutoff = new Date(Date.now() - reviewSinceHours * 60 * 60 * 1000).toISOString();
      const recentKinds = all<{ kind: string; n: number }>(
        inbound,
        "SELECT kind, COUNT(*) AS n FROM messages_in WHERE timestamp >= $cutoff AND kind != 'system' GROUP BY kind ORDER BY kind",
        { $cutoff: reviewCutoff },
      );
      const recentCount = recentKinds.reduce((sum, row) => sum + Number(row.n), 0);
      let archivedFileCount = 0;
      try {
        archivedFileCount = readdirSync(conversationDir).filter((name) => name.endsWith('.md')).length;
      } catch {
        archivedFileCount = 0;
      }
      const archiveAvailable = archivedFileCount > 0;
      reviewEvidence = {
        source: inboundPath,
        conversationDir,
        sinceHours: reviewSinceHours,
        currentSessionOnly: !archiveAvailable,
        complete: false,
        recentNonSystemRows: recentCount,
        kinds: Object.fromEntries(recentKinds.map((row) => [row.kind, Number(row.n)])),
        archiveAvailable,
        archivedFileCount,
        scheduleScope: 'session',
        note: archiveAvailable
          ? 'Health sees the current inbound.db and can confirm that a conversation archive exists; it cannot prove pending rows in other sessions were covered.'
          : 'Health can inspect one session inbound.db only; it cannot prove group-wide review coverage.',
      };
      if (recentCount > 0) {
        issues.push({
          severity: 'warn',
          code: archiveAvailable ? 'review_source_partial' : 'review_source_session_only',
          message: archiveAvailable
            ? 'recent review evidence has an archive available, but health cannot prove pending rows in other sessions were covered'
            : 'recent review evidence comes from one session inbound.db, not the full agent-group conversation history',
        });
      }
      schedules = all<Record<string, unknown>>(
        inbound,
        "SELECT id, status, process_after, recurrence, tries, content FROM messages_in WHERE kind='task' AND lower(content) LIKE '%memory%' ORDER BY process_after DESC LIMIT 20",
      ).map((row) => ({
        ...row,
        content: redactContent(typeof row.content === 'string' ? row.content : ''),
        legacy: typeof row.content === 'string' && /memory\.cjs|scripts\/memory\.cjs/.test(row.content),
      }));
      const hasCurrentRecurringReview = schedules.some((r: any) => r.status === 'pending' && r.recurrence && !r.legacy);
      const hasFailedRecurring = schedules.some((r: any) => r.status === 'failed' && r.recurrence);
      if (hasFailedRecurring && !hasCurrentRecurringReview) {
        issues.push({ severity: 'fail', code: 'failed_recurring_memory_task', message: 'a recurring memory task is failed and will not advance' });
      } else if (hasFailedRecurring) {
        issues.push({ severity: 'warn', code: 'replaced_failed_memory_task', message: 'a failed legacy recurring memory task remains in history, but a current pending review task exists' });
      }
      if (schedules.some((r: any) => r.legacy)) {
        issues.push({ severity: 'warn', code: 'legacy_memory_task', message: 'a scheduled memory task still references legacy memory.cjs' });
      }
      if (!hasCurrentRecurringReview) {
        issues.push({
          severity: 'warn',
          code: 'review_schedule_unverified',
          message: 'no pending non-legacy recurring memory review task was found in this session inbound.db; group-wide schedule presence requires scheduler/central-DB evidence',
        });
      }
    }
    inbound.close();
  }
  db.close();

  return {
    status: statusFromIssues(issues),
    dbPath,
    configPath,
    inboundPath: inboundPath ?? null,
    conversationDir,
    scope: cfg?.scope ?? null,
    approval: { required: approvalRequired, configuredOwner, metaOwner: owner },
    reflection: cfg?.reflection ?? null,
    totals,
    categories,
    access,
    events: eventStats,
    reviewEvidence,
    schedules,
    issues,
  };
}

type SuiteCase = {
  name: string;
  query: string;
  expectAny?: Array<string | number>;
  expectedAny?: Array<string | number>;
  forbidAny?: Array<string | number>;
  k?: number;
};

function matches(row: { id: number; title: string; content: string }, needle: string | number): boolean {
  if (typeof needle === 'number') return row.id === needle;
  const n = needle.toLowerCase();
  return row.title.toLowerCase().includes(n) || row.content.toLowerCase().includes(n);
}

function evalSuite(flags: Args['flags']) {
  const dbPath = str(flags, 'db') ?? '/workspace/agent/memory.db';
  const configPath = str(flags, 'config') ?? '/workspace/agent/memory.config.json';
  const suitePath = str(flags, 'suite') ?? '/workspace/agent/memory-evals.json';
  if (!existsSync(dbPath)) throw new Error(`memory DB not found: ${dbPath}`);
  if (!existsSync(suitePath)) throw new Error(`eval suite not found: ${suitePath}`);

  const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as { cases?: SuiteCase[] };
  const cases = suite.cases ?? [];
  const cfg = loadConfig(configPath);
  const dir = mkdtempSync(join(tmpdir(), 'memory-audit-'));
  const copy = join(dir, 'memory.db');
  copyFileSync(dbPath, copy);
  const db = openMemoryDb(copy, { defaultScope: cfg.scope });
  const now = new Date().toISOString();
  try {
    const availableRows = all<{ id: number; title: string; content: string }>(
      db,
      "SELECT id, title, content FROM memories WHERE scope=$scope AND status='active'",
      { $scope: cfg.scope },
    );
    const results = cases.map((c) => {
      const rows = recall(db, c.query, {
        scopes: [cfg.scope],
        limit: c.k ?? cfg.retrieval.k,
        weights: cfg.retrieval.weights,
        halflifeDays: cfg.decay.halflifeDays,
        accessNorm: cfg.decay.accessNorm,
        now,
        reinforce: false,
      });
      const expected = c.expectAny ?? c.expectedAny ?? [];
      const forbidden = c.forbidAny ?? [];
      const expectedHit = expected.length === 0 || expected.some((needle) => rows.some((r) => matches(r, needle)));
      const forbiddenHit = forbidden.some((needle) => rows.some((r) => matches(r, needle)));
      const missingExpected = expected.filter((needle) => !availableRows.some((row) => matches(row, needle)));
      const stale = expected.length > 0 && missingExpected.length === expected.length;
      return {
        name: c.name,
        query: c.query,
        passed: expectedHit && !forbiddenHit,
        expectedHit,
        forbiddenHit,
        missingExpected,
        stale,
        hits: rows.map((r) => ({ id: r.id, title: r.title, score: Number(r.score.toFixed(3)) })),
      };
    });
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed);
    const status = passed === results.length ? 'pass' : failed.every((r) => r.stale) ? 'warn' : 'fail';
    return {
      status,
      suitePath,
      passed,
      total: results.length,
      staleCases: results.filter((r) => r.stale).map((r) => r.name),
      results,
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function render(obj: any): string {
  if ('issues' in obj) {
    const lines = [`Memory audit: ${obj.status.toUpperCase()} (${obj.scope ?? 'unknown scope'})`];
    lines.push(`memories: ${obj.totals?.active ?? 0} active / ${obj.totals?.total ?? 0} total`);
    lines.push(`recall events: ${obj.events?.recall?.calls ?? 0} calls, ${obj.events?.recall?.hits ?? 0} hit calls, ${obj.events?.recall?.misses ?? 0} misses`);
    for (const issue of obj.issues ?? []) lines.push(`- ${issue.severity}: ${issue.code} - ${issue.message}`);
    return lines.join('\n');
  }
  const lines = [`Memory eval: ${obj.status.toUpperCase()} (${obj.passed}/${obj.total})`];
  for (const r of obj.results) {
    const suffix = r.stale ? ' (stale expected memory; update the eval suite)' : '';
    lines.push(`- ${r.passed ? 'pass' : r.stale ? 'warn' : 'fail'} ${r.name}${suffix}: ${r.hits.map((h: any) => `#${h.id} ${h.title}`).join('; ') || 'no hits'}`);
  }
  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
try {
  const out = args.command === 'eval' ? evalSuite(args.flags) : health(args.flags);
  console.log(args.flags.json ? JSON.stringify(out, null, 2) : render(out));
  if (out.status === 'fail') process.exitCode = 1;
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
