/**
 * Read-only view of the container skill catalog.
 *
 * The universe of skills is the shared dir `container/skills/` — every agent
 * group draws from the same set. What a group actually gets is the
 * `container_configs.skills` column: either the literal `"all"` (dynamic — any
 * newly-added skill is included) or an explicit JSON array of skill ids. At
 * container spawn `syncSkillSymlinks` (src/container-runner.ts) materializes that
 * selection as symlinks under the session's `.claude-shared/skills/`, so changes
 * only take effect on the next spawn.
 *
 * This module is display-only: it lists the catalog (with labels/descriptions
 * lifted from each skill's SKILL.md frontmatter) and resolves a group's stored
 * `skills` value into the concrete enabled set. No writes — the dashboard never
 * mutates the selection.
 */
import fs from 'fs';
import path from 'path';
import { PATHS } from '../config.js';

export interface SkillInfo {
  /** Directory name under container/skills/ — the id used in the skills column. */
  id: string;
  /** `name:` from SKILL.md frontmatter; falls back to the id when absent. */
  name: string;
  /** `description:` from SKILL.md frontmatter; empty string when absent. */
  description: string;
}

export interface ResolvedSkills {
  /** `all` = every available skill (dynamic). `list` = an explicit selection. */
  mode: 'all' | 'list';
  /** Concrete enabled ids, always intersected with the available catalog so a
   *  stale list entry (a skill no longer on disk) never shows as enabled. */
  enabledIds: Set<string>;
}

/**
 * Infrastructural skills, flagged with a "core" badge in the toggle UI so an
 * operator thinks twice before disabling them. `onecli-gateway` teaches the agent
 * how the credential proxy works and how to handle auth errors — turning it off
 * degrades that behavior (the proxy itself is network-level and keeps working).
 * This is an informational hint only, NOT a lock: groups legitimately run without
 * it (e.g. a group scoped to a single self-contained skill), so the apply path
 * never force-adds or rejects on these.
 */
export const CORE_SKILLS = new Set(['onecli-gateway']);
export const isCore = (id: string): boolean => CORE_SKILLS.has(id);

/**
 * Minimal YAML-frontmatter extractor for the two fields we render: `name` and
 * `description`. Handles inline scalars (`description: Track ...`) and folded /
 * literal block scalars (`description: >-` followed by indented lines, as
 * onecli-gateway uses). Not a general YAML parser — just enough for SKILL.md.
 */
function parseFrontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith('---')) return {};
  const end = md.indexOf('\n---', 3);
  if (end < 0) return {};
  const lines = md.slice(3, end).split('\n');
  const strip = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim();
  const out: { name?: string; description?: string } = {};
  let collecting = false;
  let descParts: string[] = [];
  const flush = () => {
    if (collecting) {
      out.description = descParts.join(' ').replace(/\s+/g, ' ').trim();
      collecting = false;
      descParts = [];
    }
  };
  for (const line of lines) {
    // A top-level key starts at column 0 (block-scalar continuation lines are indented).
    const top = /^([a-zA-Z_][\w-]*):\s?(.*)$/.exec(line);
    if (top) {
      flush();
      const [, key, rawVal] = top;
      const val = rawVal.trim();
      if (key === 'name') out.name = strip(rawVal);
      else if (key === 'description') {
        if (val && !/^[|>]/.test(val)) out.description = strip(rawVal);
        else collecting = true; // block scalar — gather indented lines below
      }
    } else if (collecting) {
      descParts.push(line.trim());
    }
  }
  flush();
  return out;
}

/**
 * The skill catalog: one entry per skill root under `container/skills/`, sorted
 * by id. A skill root has either `SKILL.md` or `instructions.md`; namespace
 * folders that only organize other skills are intentionally skipped. `dir` is
 * injectable for tests.
 */
export function listAvailableSkills(dir: string = PATHS.containerSkillsDir): SkillInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const id of entries) {
    const skillDir = path.join(dir, id);
    try {
      if (!fs.statSync(skillDir).isDirectory()) continue;
      if (!fs.existsSync(path.join(skillDir, 'SKILL.md')) && !fs.existsSync(path.join(skillDir, 'instructions.md'))) {
        continue;
      }
    } catch {
      continue;
    }
    let fm: { name?: string; description?: string } = {};
    try {
      fm = parseFrontmatter(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
    } catch {
      /* no SKILL.md — fall back to the id */
    }
    skills.push({ id, name: fm.name || id, description: fm.description ?? '' });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve a group's stored `skills` column into the concrete enabled set.
 * Mirrors `syncSkillSymlinks`: `null`/`"all"`/unparseable → every available
 * skill; an array → exactly those entries that still exist in the catalog.
 */
export function resolveGroupSkills(col: string | null, available: SkillInfo[]): ResolvedSkills {
  const allIds = new Set(available.map((s) => s.id));
  if (col == null) return { mode: 'all', enabledIds: new Set(allIds) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(col);
  } catch {
    return { mode: 'all', enabledIds: new Set(allIds) };
  }
  if (Array.isArray(parsed)) {
    const wanted = new Set(parsed.filter((x): x is string => typeof x === 'string'));
    return { mode: 'list', enabledIds: new Set([...allIds].filter((id) => wanted.has(id))) };
  }
  return { mode: 'all', enabledIds: new Set(allIds) };
}

/**
 * Validate a requested enabled-set (from the toggle UI) and decide what to
 * persist. Rejects unknown skills (which would only create dangling symlinks).
 * Collapses a full selection back to the dynamic `"all"` so re-enabling everything
 * restores auto-inclusion of future skills rather than freezing a list. An empty
 * selection is allowed — a group may legitimately run with no skills.
 */
export function planSkillsUpdate(
  requested: string[],
  available: SkillInfo[],
): { ok: true; value: string[] | 'all' } | { ok: false; error: string } {
  const availIds = new Set(available.map((s) => s.id));
  const req = [...new Set(requested.map((s) => String(s)))];
  const unknown = req.filter((s) => !availIds.has(s));
  if (unknown.length) return { ok: false, error: `Unknown skill(s): ${unknown.join(', ')}` };
  // req ⊆ availIds and is deduped, so equal length ⇒ equal sets ⇒ keep dynamic "all".
  if (available.length > 0 && req.length === available.length) return { ok: true, value: 'all' };
  return { ok: true, value: req.sort() };
}
