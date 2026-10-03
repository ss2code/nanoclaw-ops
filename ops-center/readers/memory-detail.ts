/**
 * Per-memory detail reader — the data behind the Memory Explorer drawer
 * (Knowledge Tab v2, Phase 2). Assembles a single memory's full record: its
 * fields, a lifecycle timeline (memory_journal + the recalls that referenced it),
 * structural-vs-topical tag classification, derived related memories, and
 * freshness badges. Read-only; no engine change.
 *
 * Runtime split note: parseCalTags is ported by copy from the Bun engine
 * (container/skills/memory/scripts/store.ts) — ops-center is Node + better-sqlite3
 * and cannot import across that boundary. Keep the two copies in sync.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { readMemoryDb, type MemoryRow } from './memory.js';

const DAY_MS = 86_400_000;
const DEFAULT_HALFLIFE_DAYS = 180;

export interface JournalEntry {
  at: string;
  action: string;
  detail: Record<string, unknown> | null;
}

export interface RecallRef {
  at: string;
  query: string | null;
  hitCount: number | null;
  latencyMs: number | null;
  /** This memory's blended score in that recall, if the score trace carried it. */
  score: number | null;
}

export interface RelatedMemory {
  id: number;
  title: string;
  reason: string;
}

export interface CalRef {
  calendarId: string;
  eventId: string;
}

export type StructuralTagKind = 'cal' | 'trip' | 'rel' | 'time-bound';

export interface StructuralTag {
  kind: StructuralTagKind;
  raw: string;
  label: string;
  cal?: CalRef;
}

export interface FreshnessBadge {
  level: 'info' | 'warn';
  text: string;
}

export interface MemoryDetail {
  row: MemoryRow;
  structuralTags: StructuralTag[];
  topicalTags: string[];
  journal: JournalEntry[];
  recalls: RecallRef[];
  related: RelatedMemory[];
  freshness: FreshnessBadge[];
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

function ageDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / DAY_MS;
}

/**
 * Ported verbatim from the engine (store.ts:parseCalTags). Parse
 * `cal:<calendarId>:<eventId>` tags; calendarId may itself contain ':' so split
 * on the LAST colon.
 */
export function parseCalTags(tags: string[]): CalRef[] {
  const refs: CalRef[] = [];
  for (const t of tags) {
    if (typeof t !== 'string' || !t.startsWith('cal:')) continue;
    const rest = t.slice(4);
    const sep = rest.lastIndexOf(':');
    if (sep <= 0 || sep === rest.length - 1) continue;
    refs.push({ calendarId: rest.slice(0, sep), eventId: rest.slice(sep + 1) });
  }
  return refs;
}

/**
 * Split a row's flat tag list into structural edges (cal:/trip:/rel: namespaces,
 * time-bound marker) and plain topical tags. Structural tags are edges to other
 * systems and render as chips; topical tags stay pills.
 */
export function classifyTags(tags: string[]): { structural: StructuralTag[]; topical: string[] } {
  const structural: StructuralTag[] = [];
  const topical: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    if (t.startsWith('cal:')) {
      const [ref] = parseCalTags([t]);
      structural.push({ kind: 'cal', raw: t, label: ref ? `${ref.calendarId} · ${ref.eventId.slice(0, 8)}…` : t, cal: ref });
    } else if (t.startsWith('trip:')) {
      structural.push({ kind: 'trip', raw: t, label: t.slice('trip:'.length) });
    } else if (t.startsWith('rel:')) {
      structural.push({ kind: 'rel', raw: t, label: t.slice('rel:'.length) });
    } else if (t === 'time-bound') {
      structural.push({ kind: 'time-bound', raw: t, label: 'time-bound' });
    } else {
      topical.push(t);
    }
  }
  return { structural, topical };
}

/**
 * Freshness badges for a row. `prune-candidate` mirrors the engine's
 * pruneCandidates() rule (importance ≤ 1, never accessed, older than the
 * half-life) so the tab and the CLI agree on what is prunable.
 */
export function freshnessBadges(
  row: Pick<MemoryRow, 'importance' | 'accessCount' | 'expiresAt' | 'createdAt' | 'status'>,
  opts: { halflifeDays?: number } = {},
): FreshnessBadge[] {
  const halflife = opts.halflifeDays ?? DEFAULT_HALFLIFE_DAYS;
  const badges: FreshnessBadge[] = [];
  if (row.accessCount === 0) badges.push({ level: 'info', text: 'never recalled' });
  const expAge = ageDays(row.expiresAt);
  if (expAge != null && expAge > 0) badges.push({ level: 'warn', text: 'expired' });
  const created = ageDays(row.createdAt);
  if (row.status === 'active' && row.importance <= 1 && row.accessCount === 0 && created != null && created > halflife) {
    badges.push({ level: 'warn', text: 'prune candidate' });
  }
  return badges;
}

interface RawEvent {
  at: string;
  op: string;
  query: string | null;
  hit_count: number | null;
  latency_ms: number | null;
  result_ids: string | null;
  score_json: string | null;
}

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

/** Find this memory's blended `total` in a recall's score trace, if present. */
function scoreForId(scoreJson: string | null, id: number): number | null {
  if (!scoreJson) return null;
  try {
    const parsed = JSON.parse(scoreJson);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
    const hit = arr.find((r: { id?: unknown }) => Number(r?.id) === id) as { total?: unknown; score?: unknown } | undefined;
    if (!hit) return null;
    const v = typeof hit.total === 'number' ? hit.total : typeof hit.score === 'number' ? hit.score : null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Assemble the full detail record for memory `id` in `dbPath`, or null if the
 * row does not exist. Related memories are fully derived (no engine change):
 * co-recalled ids, same scope + shared topical tag, and same cal: target.
 */
export function readMemoryDetail(dbPath: string, id: number, opts: { halflifeDays?: number } = {}): MemoryDetail | null {
  if (!fs.existsSync(dbPath) || !Number.isFinite(id)) return null;
  const snap = readMemoryDb(dbPath, 1000);
  const row = snap.rows.find((r) => r.id === id);
  if (!row) return null;

  const { structural, topical } = classifyTags(row.tags);
  const journal: JournalEntry[] = [];
  const recalls: RecallRef[] = [];
  const coRecalled = new Set<number>();

  let db: Database.Database | null = null;
  try {
    db = openReadonly(dbPath);
    if (tableExists(db, 'memory_journal')) {
      const jrows = db
        .prepare('SELECT at, action, detail_json FROM memory_journal WHERE memory_id = ? ORDER BY at ASC')
        .all(id) as { at: string; action: string; detail_json: string | null }[];
      for (const j of jrows) {
        let detail: Record<string, unknown> | null = null;
        try {
          detail = j.detail_json ? (JSON.parse(j.detail_json) as Record<string, unknown>) : null;
        } catch {
          detail = null;
        }
        journal.push({ at: j.at, action: j.action, detail });
      }
    }
    if (tableExists(db, 'memory_events')) {
      const events = db
        .prepare("SELECT at, op, query, hit_count, latency_ms, result_ids, score_json FROM memory_events WHERE op = 'recall' ORDER BY at DESC LIMIT 500")
        .all() as RawEvent[];
      for (const e of events) {
        const ids = parseIds(e.result_ids);
        if (!ids.includes(id)) continue;
        recalls.push({
          at: e.at,
          query: e.query,
          hitCount: e.hit_count,
          latencyMs: e.latency_ms,
          score: scoreForId(e.score_json, id),
        });
        for (const other of ids) if (other !== id) coRecalled.add(other);
      }
    }
  } catch {
    // A mid-write DB shouldn't take down the drawer; return what we have.
  } finally {
    db?.close();
  }

  const related = deriveRelated(row, snap.rows, structural, coRecalled);
  const freshness = freshnessBadges(row, opts);
  return { row, structuralTags: structural, topicalTags: topical, journal, recalls, related, freshness };
}

function deriveRelated(
  row: MemoryRow,
  pool: MemoryRow[],
  structural: StructuralTag[],
  coRecalled: Set<number>,
): RelatedMemory[] {
  const topical = new Set(classifyTags(row.tags).topical);
  const calTargets = new Set(structural.filter((s) => s.kind === 'cal').map((s) => s.raw));
  const byId = new Map<number, RelatedMemory>();
  const add = (r: MemoryRow, reason: string) => {
    if (r.id === row.id || byId.has(r.id)) return;
    byId.set(r.id, { id: r.id, title: r.title, reason });
  };
  // 1) co-recalled in the same recall result set
  for (const r of pool) if (coRecalled.has(r.id)) add(r, 'co-recalled');
  // 2) same cal: target
  for (const r of pool) {
    if (r.id === row.id) continue;
    if (r.tags.some((t) => calTargets.has(t))) add(r, 'same calendar event');
  }
  // 3) same scope + at least one shared topical tag
  for (const r of pool) {
    if (r.id === row.id || r.scope !== row.scope) continue;
    const shared = classifyTags(r.tags).topical.filter((t) => topical.has(t));
    if (shared.length) add(r, `shares tag ${shared[0]}`);
  }
  return [...byId.values()].slice(0, 8);
}
