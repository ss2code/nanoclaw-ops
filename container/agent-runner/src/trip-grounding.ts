import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { getOutboundDb } from './db/connection.js';
import type { MessageInRow } from './db/messages-in.js';

interface MemoryRow {
  id: number;
  category: string;
  title: string;
  content: string;
  source: string | null;
  importance: number;
}

export interface MemoryRetrieval {
  query: string;
  terms: string[];
  mode: 'match' | 'browse' | 'none';
  matched: number;
}

export interface GroundingSnapshot {
  applicable: boolean;
  coreOk: boolean;
  memoryOk: boolean;
  coreSummary: Record<string, unknown>;
  memorySummary: {
    total: number;
    active: number;
    pending: number;
    rejected: number;
    owner: string | null;
    rows: MemoryRow[];
    retrieval: MemoryRetrieval;
  };
  errors: string[];
  rememberRequested: boolean;
  prompt: string;
}

// Kept as a type alias for downstream trip skills and archived tests. The
// implementation is generic: trip.db is optional, while memory.db is the
// shared durable-facts source for every agent group.
export type TripGroundingSnapshot = GroundingSnapshot;

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name").get({ $name: name }) != null;
}

function scalar(db: Database, sql: string): number {
  return Number((db.query(sql).get() as { n: number } | null)?.n ?? 0);
}

function columns(db: Database, table: string): Set<string> {
  try {
    return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
  } catch {
    return new Set();
  }
}

function readCore(dbPath: string): { ok: boolean; summary: Record<string, unknown>; error?: string } {
  if (!fs.existsSync(dbPath)) return { ok: false, summary: {}, error: 'trip.db missing' };
  const db = new Database(dbPath, { readonly: true });
  try {
    const trip = tableExists(db, 'trip')
      ? (db.query('SELECT name, status, stage, start_date, end_date, total_budget FROM trip WHERE id = 1').get() ?? null)
      : null;
    const activeMembers = tableExists(db, 'members')
      ? (db
          .query(
            `SELECT id, display_name, platform_id, family_id
             FROM members WHERE left_at IS NULL AND excluded_from_splits = 0 ORDER BY id`,
          )
          .all() as Record<string, unknown>[])
      : [];
    const families = tableExists(db, 'families')
      ? (db.query('SELECT id, name FROM families ORDER BY id').all() as Record<string, unknown>[])
      : [];
    const openDecisions = tableExists(db, 'decisions')
      ? (db
          .query(
            `SELECT id, question, mode, options_json, tally_json, commit_by
             FROM decisions WHERE status = 'open' ORDER BY id`,
          )
          .all() as Record<string, unknown>[])
      : [];
    const scratchpad = tableExists(db, 'scratchpad')
      ? (db
          .query(`SELECT id, topic, note FROM scratchpad WHERE status = 'open' ORDER BY id`)
          .all() as Record<string, unknown>[])
      : [];
    return {
      ok: true,
      summary: {
        configured: trip != null,
        trip,
        activeMembers,
        families,
        openDecisions,
        scratchpad,
      },
    };
  } catch (error) {
    return { ok: false, summary: {}, error: `trip.db: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    db.close();
  }
}

function emptyMemorySummary(): GroundingSnapshot['memorySummary'] {
  return {
    total: 0,
    active: 0,
    pending: 0,
    rejected: 0,
    owner: null,
    rows: [],
    retrieval: { query: '', terms: [], mode: 'none', matched: 0 },
  };
}

const COMMON_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'been',
  'before',
  'can',
  'from',
  'have',
  'hello',
  'help',
  'how',
  'its',
  'just',
  'keep',
  'know',
  'make',
  'more',
  'need',
  'not',
  'our',
  'should',
  'please',
  'remember',
  'tell',
  'that',
  'the',
  'this',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
  'you',
  'your',
  'use',
]);

const HIGH_SIGNAL_FACT_TERMS = new Set([
  'address',
  'birthday',
  'dob',
  'email',
  'mobile',
  'passport',
  'phone',
  'postcode',
  'reference',
  'telephone',
  'zip',
]);
const ENTITY_CATEGORIES = new Set(['contact', 'family', 'people', 'person']);

function messageTerms(messages: MessageInRow[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const text = messageText(message).toLocaleLowerCase();
    for (const term of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (term.length < 3 || COMMON_WORDS.has(term) || seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
      if (terms.length >= 8) return terms;
    }
  }
  return terms;
}

/** Require meaningful coverage before accepting a broad fallback match. */
function requiredTermCoverage(termCount: number): number {
  if (termCount <= 1) return termCount;
  return Math.min(termCount, Math.max(2, Math.ceil(termCount * 0.4)));
}

function isHighSignalFactTerm(term: string): boolean {
  return [...HIGH_SIGNAL_FACT_TERMS].some((signal) => signal === term || signal.startsWith(term) || term.startsWith(signal));
}

function acceptsEntityAliasFallback(category: string, terms: string[], matchedTerms: string[]): boolean {
  if (terms.length !== 2 || !ENTITY_CATEGORIES.has(category.toLocaleLowerCase())) return false;
  if (terms.filter(isHighSignalFactTerm).length !== 1) return false;
  return matchedTerms.some(isHighSignalFactTerm);
}

function qualifyFtsCandidates(db: Database, rows: MemoryRow[], terms: string[], prefix: boolean): MemoryRow[] {
  if (terms.length <= 1) return rows;
  const stmt = db.query('SELECT 1 FROM memories_fts WHERE rowid = $id AND memories_fts MATCH $term LIMIT 1');
  const minimum = requiredTermCoverage(terms.length);
  return rows.filter((row) => {
    const matchedTerms = terms.filter((term) => {
      const escaped = term.replaceAll('"', '""');
      const expression = prefix ? `"${escaped}"*` : `"${escaped}"`;
      return stmt.get({ $id: row.id, $term: expression }) != null;
    });
    return matchedTerms.length >= minimum || acceptsEntityAliasFallback(row.category, terms, matchedTerms);
  });
}

function qualifyLikeCandidates(rows: MemoryRow[], terms: string[]): MemoryRow[] {
  if (terms.length <= 1) return rows;
  const minimum = requiredTermCoverage(terms.length);
  const normalizedTerms = terms.map((term) => term.toLocaleLowerCase());
  return rows.filter((row) => {
    const searchable = `${row.title}\n${row.content}`.toLocaleLowerCase();
    const matchedTerms = normalizedTerms.filter((term) => searchable.includes(term));
    return matchedTerms.length >= minimum || acceptsEntityAliasFallback(row.category, terms, matchedTerms);
  });
}

function readScope(dbPath: string): string | null {
  const configPath = path.join(path.dirname(dbPath), 'memory.config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { scope?: unknown };
    return typeof parsed.scope === 'string' ? parsed.scope : null;
  } catch {
    return null;
  }
}

function readMemory(dbPath: string, messages: MessageInRow[]): {
  ok: boolean;
  summary: TripGroundingSnapshot['memorySummary'];
  error?: string;
} {
  const empty = emptyMemorySummary();
  if (!fs.existsSync(dbPath)) return { ok: false, summary: empty, error: 'memory.db missing' };
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!tableExists(db, 'memories')) return { ok: false, summary: empty, error: 'memory.db has no memories table' };
    const memoryColumns = columns(db, 'memories');
    const scope = readScope(dbPath);
    const params: Record<string, unknown> = { $now: new Date().toISOString() };
    const clauses = ["status = 'active'"];
    if (memoryColumns.has('expires_at')) clauses.push('(expires_at IS NULL OR expires_at > $now)');
    if (scope && memoryColumns.has('scope')) {
      clauses.push('scope = $scope');
      params.$scope = scope;
    }
    const activeWhere = clauses.join(' AND ');
    const counts = db
      .query(
        `SELECT status, COUNT(*) AS n FROM memories WHERE ${
          scope && memoryColumns.has('scope') ? 'scope = $scope' : '1=1'
        } GROUP BY status`,
      )
      .all(params as any) as Array<{ status: string; n: number }>;
    const byStatus = Object.fromEntries(counts.map((row) => [row.status, Number(row.n)]));
    const owner = tableExists(db, 'meta')
      ? ((db.query("SELECT v FROM meta WHERE k = 'owner_id'").get() as { v: string } | null)?.v ?? null)
      : null;
    const browseRows = db
      .query(
        `SELECT id, category, title, content, source, importance
         FROM memories WHERE ${activeWhere}
         ORDER BY importance DESC, id DESC LIMIT 30`,
      )
      .all(params as any) as MemoryRow[];
    const terms = messageTerms(messages);
    const query = terms.join(' ');
    let matchedRows: MemoryRow[] = [];
    if (terms.length > 0) {
      if (tableExists(db, 'memories_fts')) {
        try {
          const qualifiedClauses = ["m.status = 'active'"];
          if (memoryColumns.has('expires_at')) qualifiedClauses.push('(m.expires_at IS NULL OR m.expires_at > $now)');
          if (scope && memoryColumns.has('scope')) qualifiedClauses.push('m.scope = $scope');
          const quoted = terms.map((term) => `"${term.replaceAll('"', '""')}"`);
          const expressions: Array<{ query: string; prefix: boolean }> = [{ query: quoted.join(' '), prefix: false }];
          if (terms.length > 1) expressions.push({ query: quoted.join(' OR '), prefix: false });
          expressions.push({ query: quoted.map((term) => `${term}*`).join(' OR '), prefix: true });
          for (const [index, expression] of expressions.entries()) {
            const found = db
              .query(
                `SELECT m.id, m.category, m.title, m.content, m.source, m.importance
                   FROM memories_fts
                   JOIN memories m ON m.id = memories_fts.rowid
                  WHERE memories_fts MATCH $query AND ${qualifiedClauses.join(' AND ')}
                  ORDER BY bm25(memories_fts), m.importance DESC, m.id DESC LIMIT 30`,
              )
              .all({ ...params, $query: expression.query }) as MemoryRow[];
            matchedRows = index > 0 ? qualifyFtsCandidates(db, found, terms, expression.prefix) : found;
            if (matchedRows.length > 0) break;
          }
        } catch {
          matchedRows = [];
        }
      }
      if (matchedRows.length === 0) {
        const searchable = ['title', 'content', ...(memoryColumns.has('tags') ? ['tags'] : [])];
        const likeClauses = terms.flatMap((term, index) => searchable.map((field) => `${field} LIKE $term${index}`));
        const likeParams = { ...params } as Record<string, unknown>;
        terms.forEach((term, index) => {
          likeParams[`$term${index}`] = `%${term}%`;
        });
        const found = db
          .query(
            `SELECT id, category, title, content, source, importance
               FROM memories
              WHERE ${activeWhere} AND (${likeClauses.join(' OR ')})
              ORDER BY importance DESC, id DESC LIMIT 30`,
          )
          .all(likeParams as any) as MemoryRow[];
        matchedRows = qualifyLikeCandidates(found, terms);
      }
    }
    const rows = terms.length === 0 ? browseRows : matchedRows;
    return {
      ok: true,
      summary: {
        total: counts.reduce((sum, row) => sum + Number(row.n), 0),
        active: byStatus.active ?? 0,
        pending: byStatus.pending ?? 0,
        rejected: byStatus.rejected ?? 0,
        owner,
        rows,
        retrieval: {
          query,
          terms,
          mode: matchedRows.length > 0 ? 'match' : terms.length === 0 && rows.length > 0 ? 'browse' : 'none',
          matched: matchedRows.length,
        },
      },
    };
  } catch (error) {
    return { ok: false, summary: empty, error: `memory.db: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    db.close();
  }
}

function messageText(message: MessageInRow): string {
  try {
    const parsed = JSON.parse(message.content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

function requestsRemember(messages: MessageInRow[]): boolean {
  return messages.some((message) => {
    const text = messageText(message).trim();
    if (/\b(?:do not|don't|dont|never)\s+(?:remember|note|keep in mind)\b/i.test(text)) return false;
    return (
      /^remember\b/i.test(text) ||
      /\bplease remember\b/i.test(text) ||
      /\bremember\s+(?:this|that|to)\b/i.test(text) ||
      /\bnote that\b/i.test(text) ||
      /\bkeep in mind\b/i.test(text)
    );
  });
}

function xmlText(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildGrounding(cwd: string, messages: MessageInRow[]): GroundingSnapshot {
  const tripDb = path.join(cwd, 'trip.db');
  const memoryDb = path.join(cwd, 'memory.db');
  const applicable = fs.existsSync(tripDb) || fs.existsSync(memoryDb);
  const rememberRequested = requestsRemember(messages);
  if (!applicable) {
    return {
      applicable: false,
      coreOk: false,
      memoryOk: false,
      coreSummary: {},
      memorySummary: emptyMemorySummary(),
      errors: [],
      rememberRequested,
      prompt: '',
    };
  }

  // Domain state is optional. The durable memory store is generic and should
  // not be reported as broken merely because this group has no trip.db.
  const core = fs.existsSync(tripDb)
    ? readCore(tripDb)
    : { ok: true, summary: { configured: false, available: false } as Record<string, unknown> };
  const memory = readMemory(memoryDb, messages);
  const errors = [core.error, memory.error].filter((value): value is string => Boolean(value));
  const prompt = [
    // Keep the historical element name because Ops Center readers and archived
    // transcripts use it. The payload and implementation are generic.
    '<trip_grounding source="host-mounted sqlite" authoritative="true">',
    `Domain core: ${xmlText(core.summary)}`,
    `Memory: ${xmlText(memory.summary)}`,
    rememberRequested
      ? 'The inbound message contains an explicit remember trigger. Persist it with the memory CLI and include the CLI save receipt in the response.'
      : '',
    errors.length
      ? `Grounding errors: ${xmlText(errors)}. State that grounding failed; do not describe missing or unreadable data as a clean slate.`
      : 'Use this per-turn snapshot before answering. For a specific message, use only matching memory rows; if retrieval.mode is "none", no relevant memory rows matched this message, so proceed without claiming memory facts. Broad requests without searchable terms may include the active profile.',
    '</trip_grounding>',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    applicable,
    coreOk: core.ok,
    memoryOk: memory.ok,
    coreSummary: core.summary,
    memorySummary: memory.summary,
    errors,
    rememberRequested,
    prompt,
  };
}

export function recordGrounding(messageIds: string[], snapshot: GroundingSnapshot): number | null {
  if (!snapshot.applicable) return null;
  const result = getOutboundDb()
    .prepare(
      `INSERT INTO grounding_events (
         created_at, message_ids_json, core_ok, memory_ok, core_summary_json,
         memory_summary_json, errors_json, remember_requested, memory_count_before
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      JSON.stringify(messageIds),
      snapshot.coreOk ? 1 : 0,
      snapshot.memoryOk ? 1 : 0,
      JSON.stringify(snapshot.coreSummary),
      JSON.stringify(snapshot.memorySummary),
      JSON.stringify(snapshot.errors),
      snapshot.rememberRequested ? 1 : 0,
      snapshot.memorySummary.active,
    );
  return Number(result.lastInsertRowid);
}

export function finalizeGrounding(eventId: number | null, cwd: string): void {
  if (eventId == null) return;
  const memory = readMemory(path.join(cwd, 'memory.db'), []);
  const row = getOutboundDb()
    .prepare('SELECT remember_requested, memory_count_before FROM grounding_events WHERE id = ?')
    .get(eventId) as { remember_requested: number; memory_count_before: number } | null;
  const satisfied = row?.remember_requested ? memory.summary.active > row.memory_count_before : null;
  getOutboundDb()
    .prepare(
      `UPDATE grounding_events
       SET completed_at = ?, memory_count_after = ?, remember_satisfied = ?
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), memory.summary.active, satisfied == null ? null : satisfied ? 1 : 0, eventId);
}

export function prependGrounding(prompt: string, snapshot: GroundingSnapshot): string {
  return snapshot.applicable ? `${snapshot.prompt}\n\n${prompt}` : prompt;
}

// Compatibility aliases. The runtime uses the generic names above, while
// existing trip skills, Ops Center traces, and archived tests can continue to
// import the old API until those consumers are migrated independently.
export const buildTripGrounding = buildGrounding;
export const recordTripGrounding = recordGrounding;
export const finalizeTripGrounding = finalizeGrounding;
export const prependTripGrounding = prependGrounding;
