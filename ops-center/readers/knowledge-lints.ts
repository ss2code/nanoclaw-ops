/**
 * Knowledge health & consistency lints (Knowledge Tab v2, Phase 3) — the
 * watchdog for the fleet's written storage policy. Pure functions over the same
 * read-only snapshots the Knowledge page already loads; each returns Finding[]
 * with severity, evidence, and a COPYABLE fix command. The tab stays read-only —
 * fixes run through the memory CLI / operator, never a UI write.
 *
 * Heuristics start conservative (precision over recall) and carry their evidence
 * so an operator can judge each finding. See the six lints below (findings #2-#5,
 * #10 in docs/local/knowledge-tab-v2-design.html (private overlay)).
 */
import fs from 'fs';
import path from 'path';

import { PATHS } from '../config.js';
import type { AgentGroupInfo } from './central.js';
import { readMemoryConfig, type MemoryConfig } from './knowledge-stores.js';
import { readMemoryDb, type MemoryRow } from './memory.js';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  lint: string;
  severity: Severity;
  /** Group name, or 'fleet' for cross-group findings. */
  group: string;
  title: string;
  evidence: string[];
  /** Copyable fix command or a pointer to the correct store. */
  fix: string;
}

export interface GroupSnapshot {
  group: { id: string; name: string; folder: string };
  hasDb: boolean;
  rows: MemoryRow[];
  config: MemoryConfig | null;
  localInstructions: string | null;
}

const DAY_MS = 86_400_000;
const UNTAGGED_THRESHOLD = 0.4;
const PENDING_STALE_DAYS = 7;

function scopePrefix(scope: string): string {
  const i = scope.indexOf(':');
  return i < 0 ? scope : scope.slice(0, i);
}

/** Crude singularization for near-duplicate category detection (preference↔preferences). */
function normalizeCategory(c: string): string {
  return c.toLowerCase().replace(/s$/, '');
}

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / DAY_MS;
}

/** #3 — >1 scope spelling sharing a prefix family within one DB. Recall spans the
 *  whole store by default, so this no longer hides rows from recall; it does split
 *  the per-scope dedup guard (near-dupes can slip in) and muddies provenance. */
export function lintScopeFragmentation(snaps: GroupSnapshot[]): Finding[] {
  const out: Finding[] = [];
  for (const s of snaps) {
    if (!s.rows.length) continue;
    const byPrefix = new Map<string, Map<string, number>>();
    for (const r of s.rows) {
      const p = scopePrefix(r.scope);
      if (!byPrefix.has(p)) byPrefix.set(p, new Map());
      const m = byPrefix.get(p)!;
      m.set(r.scope, (m.get(r.scope) ?? 0) + 1);
    }
    for (const [prefix, spellings] of byPrefix) {
      if (spellings.size <= 1) continue;
      const parts = [...spellings.entries()].sort((a, b) => b[1] - a[1]);
      out.push({
        lint: 'scope-fragmentation',
        severity: 'low',
        group: s.group.name,
        title: `${spellings.size} '${prefix}:' scope spellings in one store — dedup/provenance split (recall still spans all)`,
        evidence: parts.map(([sc, n]) => `${sc} — ${n} row${n === 1 ? '' : 's'}`),
        fix: `Recall is unaffected (reads default to the whole store). Optional cleanup: on the next edit of a drifted row, re-save it under the canonical scope "${parts[0][0]}" so the dedup guard and provenance line up.`,
      });
    }
  }
  return out;
}

/** #4 — categories drifting from the config vocabulary, and near-duplicate names across the fleet. */
export function lintCategoryDrift(snaps: GroupSnapshot[]): Finding[] {
  const out: Finding[] = [];
  // (a) per group: row categories not declared in memory.config.json
  for (const s of snaps) {
    if (!s.config?.categories?.length || !s.rows.length) continue;
    const declared = new Set(s.config.categories);
    const undeclared = new Map<string, number>();
    for (const r of s.rows) if (!declared.has(r.category)) undeclared.set(r.category, (undeclared.get(r.category) ?? 0) + 1);
    if (undeclared.size) {
      out.push({
        lint: 'category-drift',
        severity: 'medium',
        group: s.group.name,
        title: `${undeclared.size} categor${undeclared.size === 1 ? 'y' : 'ies'} not in memory.config.json vocabulary`,
        evidence: [...undeclared.entries()].map(([c, n]) => `${c} — ${n} row${n === 1 ? '' : 's'} (declared: ${s.config!.categories!.join(', ')})`),
        fix: `# either fix the rows or add the category to memory.config.json:\nmemory update <id> --category <declared-category>`,
      });
    }
  }
  // (b) fleet: near-duplicate category names that differ only by plural/case
  const rawByNorm = new Map<string, Set<string>>();
  const groupsByRaw = new Map<string, Set<string>>();
  for (const s of snaps) {
    for (const r of s.rows) {
      const norm = normalizeCategory(r.category);
      if (!rawByNorm.has(norm)) rawByNorm.set(norm, new Set());
      rawByNorm.get(norm)!.add(r.category);
      if (!groupsByRaw.has(r.category)) groupsByRaw.set(r.category, new Set());
      groupsByRaw.get(r.category)!.add(s.group.name);
    }
  }
  for (const [norm, raws] of rawByNorm) {
    if (raws.size <= 1) continue;
    out.push({
      lint: 'category-drift',
      severity: 'medium',
      group: 'fleet',
      title: `near-duplicate categories across the fleet: ${[...raws].map((r) => `'${r}'`).join(' vs ')}`,
      evidence: [...raws].map((r) => `${r} — used in ${[...(groupsByRaw.get(r) ?? [])].join(', ')}`),
      fix: `# pick one spelling ('${[...raws][0]}') and standardize the config vocabulary + rows fleet-wide (norm='${norm}')`,
    });
  }
  return out;
}

/** #2 — config without a db (expected-missing) or a db without config (orphaned). */
export function lintConfigDbMismatch(snaps: GroupSnapshot[]): Finding[] {
  const out: Finding[] = [];
  for (const s of snaps) {
    if (s.config && !s.hasDb) {
      out.push({
        lint: 'config-db-mismatch',
        severity: 'medium',
        group: s.group.name,
        title: 'memory.config.json declares a memory system, but memory.db does not exist',
        evidence: [`scope ${s.config.scope ?? '?'} · ${s.config.categories?.length ?? 0} categories declared · no memory.db on disk`],
        fix: `# initialize the store (from the group container): memory remember "first fact" --category <cat>\n# …or remove groups/${s.group.folder}/memory.config.json if the store is intentionally absent`,
      });
    } else if (!s.config && s.hasDb) {
      out.push({
        lint: 'config-db-mismatch',
        severity: 'low',
        group: s.group.name,
        title: 'memory.db has no memory.config.json — runs on engine defaults (no declared vocabulary/approval)',
        evidence: [`${s.rows.length} rows with no policy file`],
        fix: `# add groups/${s.group.folder}/memory.config.json to declare categories + approval policy`,
      });
    }
  }
  return out;
}

/** #5 — a high fraction of untagged rows (tags second-class; nothing to browse by). */
export function lintUntaggedRows(snaps: GroupSnapshot[], threshold = UNTAGGED_THRESHOLD): Finding[] {
  const out: Finding[] = [];
  for (const s of snaps) {
    const active = s.rows.filter((r) => r.status === 'active');
    if (active.length < 3) continue;
    const untagged = active.filter((r) => r.tags.length === 0);
    const frac = untagged.length / active.length;
    if (frac >= threshold) {
      out.push({
        lint: 'untagged-rows',
        severity: 'low',
        group: s.group.name,
        title: `${Math.round(frac * 100)}% of active memories have no tags (${untagged.length}/${active.length})`,
        evidence: untagged.slice(0, 6).map((r) => `#${r.id} ${r.title}`),
        fix: `# run an agent-side reflection pass to tag: ${untagged.slice(0, 8).map((r) => `#${r.id}`).join(' ')}`,
      });
    }
  }
  return out;
}

// Task-shaped: an actionable item with a status/owner/due date that belongs on
// the task board, not in memory. Conservative — requires a status/due signal.
const TASK_SHAPE = /\b(todo|to-do|due (by|on|date)|deadline|follow[- ]up|waiting on|blocked on|status:\s*(todo|doing|done|waiting)|next step|action item|remind me)\b/i;
// Dated status line in operating memory — goes stale, shouldn't live in CLAUDE.local.md.
const DATED_STATUS = /^\s*[-*]?\s*(as of|status|update[d]?|last\s+\w+)\b.*\b\d{4}-\d{2}-\d{2}\b/im;

/** #10 — store-separation policy watchdog (tasks/dated-status in the wrong store). */
export function lintStoreSeparation(snaps: GroupSnapshot[]): Finding[] {
  const out: Finding[] = [];
  for (const s of snaps) {
    // task-shaped memories
    const taskish = s.rows.filter((r) => r.status === 'active' && (TASK_SHAPE.test(r.title) || TASK_SHAPE.test(r.content)));
    if (taskish.length) {
      out.push({
        lint: 'store-separation',
        severity: 'medium',
        group: s.group.name,
        title: `${taskish.length} task-shaped memor${taskish.length === 1 ? 'y' : 'ies'} — tasks belong on the Google Tasks board, not in memory`,
        evidence: taskish.slice(0, 5).map((r) => `#${r.id} ${r.title}`),
        fix: `# move to the task board (via Jeeves) and forget the memory rows: ${taskish.slice(0, 6).map((r) => `memory forget ${r.id}`).join('; ')}`,
      });
    }
    // dated status lines in CLAUDE.local.md
    if (s.localInstructions && DATED_STATUS.test(s.localInstructions)) {
      const lines = s.localInstructions
        .split('\n')
        .filter((l) => DATED_STATUS.test(l))
        .slice(0, 5)
        .map((l) => l.trim().slice(0, 120));
      out.push({
        lint: 'store-separation',
        severity: 'medium',
        group: s.group.name,
        title: 'dated status lines in CLAUDE.local.md — durable facts go to memory, actions to the task board',
        evidence: lines,
        fix: `# move each dated status out of groups/${s.group.folder}/CLAUDE.local.md into memory (facts) or the task board (actions)`,
      });
    }
  }
  return out;
}

/** staleness — expired-but-active rows and pending approvals older than 7 days. */
export function lintStaleness(snaps: GroupSnapshot[]): Finding[] {
  const out: Finding[] = [];
  for (const s of snaps) {
    const expired = s.rows.filter((r) => r.status === 'active' && daysAgo(r.expiresAt) != null && (daysAgo(r.expiresAt) as number) > 0);
    if (expired.length) {
      out.push({
        lint: 'staleness',
        severity: 'low',
        group: s.group.name,
        title: `${expired.length} expired memor${expired.length === 1 ? 'y' : 'ies'} still active`,
        evidence: expired.slice(0, 5).map((r) => `#${r.id} ${r.title} — expired ${r.expiresAt}`),
        fix: `# ${expired.slice(0, 6).map((r) => `memory forget ${r.id}`).join('; ')}`,
      });
    }
    const stalePending = s.rows.filter((r) => r.status === 'pending' && daysAgo(r.updatedAt) != null && (daysAgo(r.updatedAt) as number) > PENDING_STALE_DAYS);
    if (stalePending.length) {
      out.push({
        lint: 'staleness',
        severity: 'low',
        group: s.group.name,
        title: `${stalePending.length} pending approval${stalePending.length === 1 ? '' : 's'} older than ${PENDING_STALE_DAYS} days`,
        evidence: stalePending.slice(0, 5).map((r) => `#${r.id} ${r.title} — pending since ${r.updatedAt}`),
        fix: `# review: memory approve <id>  or  memory reject <id>`,
      });
    }
  }
  return out;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Run every lint over the snapshots and return findings sorted by severity. */
export function runKnowledgeLints(snaps: GroupSnapshot[]): Finding[] {
  const findings = [
    ...lintScopeFragmentation(snaps),
    ...lintCategoryDrift(snaps),
    ...lintConfigDbMismatch(snaps),
    ...lintUntaggedRows(snaps),
    ...lintStoreSeparation(snaps),
    ...lintStaleness(snaps),
  ];
  return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.group.localeCompare(b.group));
}

/** Assemble read-only snapshots for every agent group (rows + config + local instructions). */
export function buildLintSnapshots(groups: AgentGroupInfo[], opts: { groupsDir?: string } = {}): GroupSnapshot[] {
  const groupsDir = opts.groupsDir ?? PATHS.groupsDir;
  const snaps: GroupSnapshot[] = [];
  for (const g of groups) {
    const dir = path.join(groupsDir, g.folder);
    if (!fs.existsSync(dir)) continue;
    const dbPath = path.join(dir, 'memory.db');
    const hasDb = fs.existsSync(dbPath);
    const snap = hasDb ? readMemoryDb(dbPath, 1000) : null;
    let localInstructions: string | null = null;
    try {
      localInstructions = fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf8');
    } catch {
      localInstructions = null;
    }
    snaps.push({
      group: { id: g.id, name: g.name, folder: g.folder },
      hasDb,
      rows: snap?.rows ?? [],
      config: readMemoryConfig(dir),
      localInstructions,
    });
  }
  return snaps;
}
