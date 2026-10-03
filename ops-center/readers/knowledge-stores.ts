/**
 * Knowledge store registry — the manifest-driven inventory behind the Knowledge
 * tab's "Knowledge Stores" section (Knowledge Tab v2, Phase 1).
 *
 * Replaces the old hardcoded 5-file probe in server.ts with per-group *scanning*
 * that (a) discovers every known knowledge surface, (b) reports a real status
 * enum (present / expected-missing / orphaned / unreadable) instead of always
 * "present", and (c) surfaces health badges. Detection returns typed DATA only;
 * server.ts owns all HTML rendering and escaping, and the detail bodies are
 * fetched lazily through /api/knowledge/store rather than embedded per page view.
 *
 * Read-only: any SQLite peek here goes through readMemoryDb / inspectSqliteDb,
 * both of which open readonly + query_only. Never opens the engine's writer path.
 */
import fs from 'fs';
import path from 'path';

import { PATHS, ROOT } from '../config.js';
import type { AgentGroupInfo } from './central.js';
import { readMemoryDb } from './memory.js';

/** How the row's detail body should be rendered when its <details> is opened. */
export type StoreDetailKind = 'text' | 'docs' | 'sqlite' | 'config' | 'artifacts' | 'none';

export type StoreStatus = 'present' | 'expected-missing' | 'orphaned' | 'unreadable';

export interface HealthBadge {
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface StoreHit {
  /** Machine kind, e.g. 'curated-memory' | 'engine-config' | 'local-instructions'. */
  kind: string;
  /** Human label shown in the store column, e.g. 'curated memory'. */
  label: string;
  /** Repo-relative path (also the lazy-detail lookup key). Synthetic for externals. */
  relPath: string;
  /** Absolute path for the detail renderer; null when the store is not on disk. */
  absPath: string | null;
  status: StoreStatus;
  /** One-line status string for the row. */
  summary: string;
  updated: string | null;
  detail: StoreDetailKind;
  health: HealthBadge[];
}

export interface GroupStores {
  group: { id: string; name: string; folder: string };
  stores: StoreHit[];
  /** Count of stores whose status is not 'present' — drives the card warn badge. */
  warnCount: number;
}

const DAY_MS = 86_400_000;
const STALE_MEMORY_DAYS = 30;

/** Top-level names that belong to a first-class store (so they're never "artifacts"). */
const CLAIMED_FILES = new Set([
  'memory.db',
  'memory.config.json',
  'CLAUDE.local.md',
  'CLAUDE.md',
  'trip.db',
  'workflows.db',
  'personality.md',
  'container.json',
  'package.json',
  'package-lock.json',
  '.claude-shared.md',
]);

/** Extensions that count as generated knowledge/data artifacts. */
const ARTIFACT_EXT = /\.(md|html?|json|jsonl|csv|txt|ya?ml|py|mjs)$/i;

function statMtime(p: string): string | null {
  try {
    return new Date(fs.statSync(p).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function fmtBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / DAY_MS;
}

export interface MemoryConfig {
  scope?: string;
  categories?: string[];
  reflection?: { cadence?: string; autoCommit?: boolean };
  approval?: { required?: boolean; owner?: string };
  [k: string]: unknown;
}

/** Parse a group's memory.config.json, or null if absent/unreadable. */
export function readMemoryConfig(groupDir: string): MemoryConfig | null {
  const file = path.join(groupDir, 'memory.config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as MemoryConfig;
  } catch {
    return null;
  }
}

/** List top-level generated artifacts (files not claimed by a first-class store). */
export function listGroupArtifacts(groupDir: string): { name: string; size: number; updated: string | null }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(groupDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; size: number; updated: string | null }[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (!e.isFile()) continue;
    if (CLAIMED_FILES.has(e.name)) continue;
    if (!ARTIFACT_EXT.test(e.name)) continue;
    const full = path.join(groupDir, e.name);
    try {
      const st = fs.statSync(full);
      out.push({ name: e.name, size: st.size, updated: new Date(st.mtimeMs).toISOString() });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
}

/** The curated-memory + engine-config pair — the heart of finding #2 (config w/o db). */
function memoryStores(groupDir: string, relBase: string): StoreHit[] {
  const dbPath = path.join(groupDir, 'memory.db');
  const cfgPath = path.join(groupDir, 'memory.config.json');
  const dbExists = fs.existsSync(dbPath);
  const cfg = readMemoryConfig(groupDir);
  const cfgExists = cfg != null;
  const out: StoreHit[] = [];

  if (dbExists) {
    const snap = readMemoryDb(dbPath);
    const health: HealthBadge[] = [];
    if (!snap.available || snap.error) {
      out.push({
        kind: 'curated-memory',
        label: 'curated memory',
        relPath: `${relBase}/memory.db`,
        absPath: dbPath,
        status: 'unreadable',
        summary: snap.error ?? 'unreadable',
        updated: statMtime(dbPath),
        detail: 'sqlite',
        health: [{ level: 'error', text: 'unreadable' }],
      });
    } else {
      if (snap.pending > 0) health.push({ level: 'warn', text: `${snap.pending} pending approval${snap.pending === 1 ? '' : 's'}` });
      const stale = ageDays(snap.lastUpdated);
      if (stale != null && stale > STALE_MEMORY_DAYS) health.push({ level: 'warn', text: `stale ${Math.round(stale)}d` });
      if (!cfgExists) health.push({ level: 'warn', text: 'no memory.config.json' });
      out.push({
        kind: 'curated-memory',
        label: 'curated memory',
        relPath: `${relBase}/memory.db`,
        absPath: dbPath,
        // db without a config is "orphaned" — it runs on engine defaults with no
        // declared vocabulary/approval policy (finding #2, inverse case).
        status: cfgExists ? 'present' : 'orphaned',
        summary: `${snap.total} row${snap.total === 1 ? '' : 's'}${snap.pending ? ` · ${snap.pending} pending` : ''} · ${fmtBytesShort(snap.dbSizeBytes)}`,
        updated: snap.lastUpdated ?? statMtime(dbPath),
        detail: 'sqlite',
        health,
      });
    }
  } else if (cfgExists) {
    // Config promises a memory system that doesn't exist yet — surface it as a
    // first-class row instead of silently omitting it (finding #2).
    out.push({
      kind: 'curated-memory',
      label: 'curated memory',
      relPath: `${relBase}/memory.db`,
      absPath: null,
      status: 'expected-missing',
      summary: 'memory.config.json declares a memory system, but memory.db does not exist',
      updated: null,
      detail: 'none',
      health: [{ level: 'warn', text: 'expected but missing' }],
    });
  }

  if (cfgExists) {
    const cats = Array.isArray(cfg!.categories) ? cfg!.categories.length : 0;
    const approval = cfg!.approval?.required ? 'approval required' : 'auto-commit';
    const cadence = cfg!.reflection?.cadence ? `${cfg!.reflection.cadence} reflection` : 'no reflection';
    out.push({
      kind: 'engine-config',
      label: 'engine config',
      relPath: `${relBase}/memory.config.json`,
      absPath: cfgPath,
      status: 'present',
      summary: `${cats} categor${cats === 1 ? 'y' : 'ies'} · ${approval} · ${cadence}`,
      updated: statMtime(cfgPath),
      detail: 'config',
      health: [],
    });
  }
  return out;
}

/**
 * Docs detection for the legacy per-group knowledge view. The document hub is
 * the canonical publication surface; this view only reports a local `docs/`
 * directory when one exists.
 */
function docsStore(groupDir: string, relBase: string): StoreHit | null {
  const docsDir = path.join(groupDir, 'docs');
  if (!fs.existsSync(docsDir)) return null;
  let count: number | null;
  try {
    count = fs.readdirSync(docsDir).filter((name) => !name.startsWith('.')).length;
  } catch {
    count = null;
  }
  const items = count === null ? null : `${count} item${count === 1 ? '' : 's'}`;
  return {
    kind: 'docs',
    label: 'docs',
    relPath: `${relBase}/docs`,
    absPath: docsDir,
    status: count === null ? 'unreadable' : 'present',
    summary: items ?? 'unreadable',
    updated: statMtime(docsDir),
    detail: 'docs',
    health: [],
  };
}

function conversationsStore(groupDir: string, relBase: string): StoreHit | null {
  const dir = path.join(groupDir, 'conversations');
  if (!fs.existsSync(dir)) return null;
  let count: number | null = null;
  try {
    count = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).length;
  } catch {
    count = null;
  }
  const updated = statMtime(dir);
  const age = ageDays(updated);
  const lastActive = age == null ? 'unknown' : age < 1 ? 'today' : `${Math.round(age)}d ago`;
  return {
    kind: 'conversations',
    label: 'conversations',
    relPath: `${relBase}/conversations`,
    absPath: dir,
    status: count === null ? 'unreadable' : 'present',
    summary: count === null ? 'unreadable' : `${count} transcript${count === 1 ? '' : 's'} · last active ${lastActive}`,
    updated,
    detail: 'docs',
    health: [],
  };
}

function textStore(
  groupDir: string,
  relBase: string,
  name: string,
  kind: string,
  label: string,
): StoreHit | null {
  const file = path.join(groupDir, name);
  if (!fs.existsSync(file)) return null;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* ignore */
  }
  return {
    kind,
    label,
    relPath: `${relBase}/${name}`,
    absPath: file,
    status: 'present',
    summary: `${fmtBytesShort(size)} text`,
    updated: statMtime(file),
    detail: 'text',
    health: [],
  };
}

function sqliteStore(
  groupDir: string,
  relBase: string,
  name: string,
  kind: string,
  label: string,
): StoreHit | null {
  const file = path.join(groupDir, name);
  if (!fs.existsSync(file)) return null;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* ignore */
  }
  return {
    kind,
    label,
    relPath: `${relBase}/${name}`,
    absPath: file,
    status: 'present',
    summary: `${fmtBytesShort(size)} database`,
    updated: statMtime(file),
    detail: 'sqlite',
    health: [],
  };
}

function artifactsStore(groupDir: string, relBase: string): StoreHit | null {
  const items = listGroupArtifacts(groupDir);
  if (!items.length) return null;
  const newest = items[0]?.updated ?? null;
  return {
    kind: 'artifacts',
    label: 'generated artifacts',
    relPath: `${relBase}/*artifacts`,
    absPath: groupDir,
    status: 'present',
    summary: `${items.length} generated file${items.length === 1 ? '' : 's'} (profiles, reports, data)`,
    updated: newest,
    detail: 'artifacts',
    health: [],
  };
}

/**
 * External-store stub: the fleet's single task store is the Google Tasks board,
 * reached only with an agent's OneCLI credentials — deliberately out of host
 * reach (matches the deferred container→host safety question). We surface it as
 * a reachability/config row when the group's local instructions reference it.
 */
function externalTasksStore(groupDir: string, relBase: string): StoreHit | null {
  const local = path.join(groupDir, 'CLAUDE.local.md');
  let text = '';
  try {
    text = fs.readFileSync(local, 'utf8');
  } catch {
    return null;
  }
  if (!/google tasks|task board|task_/i.test(text)) return null;
  return {
    kind: 'external',
    label: 'Google Tasks (external)',
    relPath: `${relBase}/*google-tasks`,
    absPath: null,
    status: 'present',
    summary: 'external task store · reachability only (contents need the agent’s OneCLI credentials)',
    updated: null,
    detail: 'none',
    health: [{ level: 'info', text: 'external — not host-readable' }],
  };
}

/** Scan one agent group's directory for every known knowledge store. */
export function scanGroupStores(groupDir: string, group: { id: string; name: string; folder: string }): GroupStores {
  const relBase = `groups/${group.folder}`;
  const stores: StoreHit[] = [];
  stores.push(...memoryStores(groupDir, relBase));
  const local = textStore(groupDir, relBase, 'CLAUDE.local.md', 'local-instructions', 'local instructions');
  if (local) stores.push(local);
  const base = textStore(groupDir, relBase, 'CLAUDE.md', 'group-instructions', 'instructions');
  if (base) stores.push(base);
  const personality = textStore(groupDir, relBase, 'personality.md', 'personality', 'personality');
  if (personality) stores.push(personality);
  const trip = sqliteStore(groupDir, relBase, 'trip.db', 'trip-state', 'trip state');
  if (trip) stores.push(trip);
  const workflows = sqliteStore(groupDir, relBase, 'workflows.db', 'workflow-state', 'workflow state');
  if (workflows) stores.push(workflows);
  const conversations = conversationsStore(groupDir, relBase);
  if (conversations) stores.push(conversations);
  const docs = docsStore(groupDir, relBase);
  if (docs) stores.push(docs);
  const artifacts = artifactsStore(groupDir, relBase);
  if (artifacts) stores.push(artifacts);
  const external = externalTasksStore(groupDir, relBase);
  if (external) stores.push(external);

  sortStores(stores);
  return {
    group,
    stores,
    warnCount: stores.filter((s) => s.status !== 'present').length,
  };
}

/** Scan every agent group; groups with mismatches sort to the top. */
export function scanFleetStores(groups: AgentGroupInfo[], opts: { groupsDir?: string } = {}): GroupStores[] {
  const groupsDir = opts.groupsDir ?? PATHS.groupsDir;
  const result: GroupStores[] = [];
  for (const g of groups) {
    const dir = path.join(groupsDir, g.folder);
    if (!fs.existsSync(dir)) continue;
    result.push(scanGroupStores(dir, { id: g.id, name: g.name, folder: g.folder }));
  }
  return result.sort((a, b) => b.warnCount - a.warnCount || a.group.name.localeCompare(b.group.name));
}

/**
 * Fleet-shared knowledge every group inherits: the base container/CLAUDE.md
 * (model routing + storage policy) and the container skills' instruction files.
 */
export function scanFleetSharedKnowledge(opts: { root?: string } = {}): StoreHit[] {
  const root = opts.root ?? ROOT;
  const out: StoreHit[] = [];
  const baseMd = path.join(root, 'container', 'CLAUDE.md');
  if (fs.existsSync(baseMd)) {
    out.push({
      kind: 'base-instructions',
      label: 'base instructions',
      relPath: 'container/CLAUDE.md',
      absPath: baseMd,
      status: 'present',
      summary: 'inherited by every agent group (model routing, storage policy)',
      updated: statMtime(baseMd),
      detail: 'text',
      health: [],
    });
  }
  const skillsDir = path.join(root, 'container', 'skills');
  let skills: string[] = [];
  try {
    skills = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    skills = [];
  }
  for (const skill of skills) {
    const skillMd = path.join(skillsDir, skill, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    out.push({
      kind: 'container-skill',
      label: `skill: ${skill}`,
      relPath: `container/skills/${skill}/SKILL.md`,
      absPath: skillMd,
      status: 'present',
      summary: 'loaded into every agent session',
      updated: statMtime(skillMd),
      detail: 'text',
      health: [],
    });
  }
  return out;
}

const STATUS_RANK: Record<StoreStatus, number> = {
  'unreadable': 0,
  'expected-missing': 1,
  'orphaned': 2,
  'present': 3,
};

function sortStores(stores: StoreHit[]): void {
  stores.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.label.localeCompare(b.label));
}

/**
 * Resolve a lazy-detail request to a known store, or null if the (group, path)
 * pair is not one the registry produced. This is the path-safety gate for
 * /api/knowledge/store: only registry-known absolute paths are ever serveable.
 */
export function resolveStoreForDetail(
  groupParam: string,
  relPath: string,
  groups: AgentGroupInfo[],
  opts: { groupsDir?: string; root?: string } = {},
): StoreHit | null {
  const candidates =
    groupParam === '__fleet__'
      ? scanFleetSharedKnowledge({ root: opts.root })
      : (() => {
          const g = groups.find((x) => x.id === groupParam);
          if (!g) return [];
          const dir = path.join(opts.groupsDir ?? PATHS.groupsDir, g.folder);
          if (!fs.existsSync(dir)) return [];
          return scanGroupStores(dir, { id: g.id, name: g.name, folder: g.folder }).stores;
        })();
  const hit = candidates.find((s) => s.relPath === relPath && s.absPath != null);
  if (!hit) return null;
  // Belt-and-suspenders: the resolved absolute path must stay under the repo root.
  const real = (() => {
    try {
      return fs.realpathSync(hit.absPath!);
    } catch {
      return hit.absPath!;
    }
  })();
  const rootReal = (() => {
    try {
      return fs.realpathSync(opts.root ?? ROOT);
    } catch {
      return opts.root ?? ROOT;
    }
  })();
  // Registered docs surfaces may resolve through a symlink; block anything else
  // that escapes the root.
  if (hit.kind !== 'docs' && real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) return null;
  return hit;
}
