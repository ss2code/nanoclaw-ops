/**
 * Orphan detection & safe cleanup.
 *
 * When an agent group is deleted, `ncl groups delete` removes DB rows only —
 * on-disk artifacts are deliberately left behind (deleting disk state based on
 * the *absence* of a DB row is dangerous to do automatically). Two kinds:
 *   - data/v2-sessions/<group-id>/  — conversation history, session DBs, JSONLs
 *   - groups/<folder>/              — the group's workspace (CLAUDE.md, memory)
 *
 * Cleanup is a MOVE to data/trash/<stamp>/, never an rm — reversible by hand.
 * The path is re-validated as an orphan at action time, so a stale button
 * can't move a live group's data.
 */
import fs from 'fs';
import path from 'path';
import { PATHS, ROOT } from './config.js';
import { listAgentGroups } from './readers/central.js';
import { dirSizeBytes } from './readers/system.js';

export interface Orphan {
  /** 'session-data' | 'group-folder' */
  kind: 'session-data' | 'group-folder';
  /** Name of the orphaned directory (group id or folder name). */
  name: string;
  /** Path relative to repo root — the cleanup API token. */
  relPath: string;
  sizeBytes: number;
}

export const GROUPS_DIR = path.join(ROOT, 'groups');
export const TRASH_DIR = path.join(ROOT, 'data', 'trash');

export function findOrphans(
  sessionsRoot: string = PATHS.sessionsDir,
  groupsRoot: string = GROUPS_DIR,
  groups: { id: string; folder: string }[] = listAgentGroups(),
): Orphan[] {
  const ids = new Set(groups.map((g) => g.id));
  const folders = new Set(groups.map((g) => g.folder));
  const out: Orphan[] = [];
  if (fs.existsSync(sessionsRoot)) {
    for (const entry of fs.readdirSync(sessionsRoot)) {
      const p = path.join(sessionsRoot, entry);
      if (entry.startsWith('.') || !fs.statSync(p).isDirectory()) continue;
      if (!ids.has(entry))
        out.push({ kind: 'session-data', name: entry, relPath: path.relative(ROOT, p), sizeBytes: dirSizeBytes(p) });
    }
  }
  if (fs.existsSync(groupsRoot)) {
    for (const entry of fs.readdirSync(groupsRoot)) {
      const p = path.join(groupsRoot, entry);
      if (entry.startsWith('.') || !fs.statSync(p).isDirectory()) continue;
      if (!folders.has(entry))
        out.push({ kind: 'group-folder', name: entry, relPath: path.relative(ROOT, p), sizeBytes: dirSizeBytes(p) });
    }
  }
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export interface CleanupResult {
  ok: boolean;
  message: string;
}

/**
 * Move one orphan to data/trash/<stamp>/<kind>-<name>. Re-validates that the
 * path is still an orphan right now; refuses anything else.
 */
export function cleanupOrphan(
  relPath: string,
  opts: {
    sessionsRoot?: string;
    groupsRoot?: string;
    trashRoot?: string;
    groups?: { id: string; folder: string }[];
    stamp?: string;
  } = {},
): CleanupResult {
  const trashRoot = opts.trashRoot ?? TRASH_DIR;
  const orphans = findOrphans(opts.sessionsRoot, opts.groupsRoot, opts.groups);
  const match = orphans.find((o) => o.relPath === relPath);
  if (!match) return { ok: false, message: `refusing: ${relPath} is not currently an orphan` };
  const src = path.join(ROOT, relPath);
  const stamp = (opts.stamp ?? new Date().toISOString()).replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(trashRoot, stamp, `${match.kind}-${match.name}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return { ok: true, message: `Moved to ${path.relative(ROOT, dest)} (restore by moving it back; delete later to free disk)` };
}

/** Contents of data/trash for the System tab. */
export function listTrash(trashRoot: string = TRASH_DIR): { name: string; sizeBytes: number }[] {
  if (!fs.existsSync(trashRoot)) return [];
  return fs
    .readdirSync(trashRoot)
    .sort()
    .reverse()
    .map((stamp) => ({ name: stamp, sizeBytes: dirSizeBytes(path.join(trashRoot, stamp)) }));
}
