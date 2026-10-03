/**
 * Provider-agnostic template-skill materialization.
 *
 * Older stamped templates store skills as REAL directories in the group-private
 * store `data/v2-sessions/<group-id>/.claude-shared/skills/<name>`
 * (src/templates/create-agent.ts). That store remains the recovery/mirror
 * source. Live templates are mounted directly by template-runtime.ts. Claude
 * reads the store directly — it is mounted at `~/.claude/skills`, and
 * real dirs survive the symlink-only skill-link prune. Every OTHER surfaces-owning
 * provider (codex, opencode, pi, …) reads a DIFFERENT per-group skills directory,
 * often READ-ONLY-mounted, so the skills must be copied there host-side, before
 * the container starts.
 *
 * This is the single shared spot that does that copy. Each provider's host-side
 * container contribution calls it once with its own skills dir (codex →
 * `.agents/skills`; a future provider → whatever it reads). Adding a provider
 * therefore adds one call, not a new mirror implementation. The copied dirs are
 * real (not symlinks), so they survive providers' symlink-only prunes and persist
 * across respawns.
 *
 * This module is a main-owned seam that provider payloads (on the `providers`
 * donor branch) import — mirrors src/group-persona.ts.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

/** The group-private store templates stamp skills into (Claude's read plane). */
function templateSkillsSource(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
}

/** Compare a managed template-skill tree without following symlinks. */
function sameTree(left: string, right: string): boolean {
  let leftStat: fs.Stats;
  let rightStat: fs.Stats;
  try {
    leftStat = fs.lstatSync(left);
    rightStat = fs.lstatSync(right);
  } catch {
    return false;
  }

  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    if (!leftStat.isSymbolicLink() || !rightStat.isSymbolicLink()) return false;
    try {
      return fs.readlinkSync(left) === fs.readlinkSync(right);
    } catch {
      return false;
    }
  }
  if (leftStat.isDirectory() || rightStat.isDirectory()) {
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
    const leftEntries = fs.readdirSync(left).sort();
    const rightEntries = fs.readdirSync(right).sort();
    if (leftEntries.length !== rightEntries.length) return false;
    return leftEntries.every(
      (name, index) => name === rightEntries[index] && sameTree(path.join(left, name), path.join(right, name)),
    );
  }
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
}

/**
 * Copy a group's template skills into a provider's per-group skills directory.
 * No-op if the group has no template skills, or if `destSkillsDir` IS the source
 * (Claude, which reads the source directly — copying onto itself would delete it).
 * Idempotent: overwrites each template skill so edits propagate on respawn. It
 * manages only its own skill dirs — other entries in the destination (e.g. a
 * provider's shared-skill symlinks) are left untouched.
 */
export function materializeTemplateSkills(agentGroupId: string, destSkillsDir: string): void {
  const src = templateSkillsSource(agentGroupId);
  if (!fs.existsSync(src)) return;
  if (path.resolve(src) === path.resolve(destSkillsDir)) return;

  fs.mkdirSync(destSkillsDir, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const source = path.join(src, name);
    // Shared container skills are intentionally dangling host-side symlinks
    // (their /app/skills targets exist only inside the container). Template
    // skills are real directories; never follow or copy the host-only links.
    let sourceStat: fs.Stats;
    try {
      sourceStat = fs.lstatSync(source);
    } catch {
      continue;
    }
    if (!sourceStat.isDirectory()) continue;

    const dest = path.join(destSkillsDir, name);
    // Some macOS group workspaces carry a delete-deny ACL on the provider
    // skills directory. An unchanged materialized tree needs no replacement;
    // skipping the delete keeps a cold start from failing before the
    // container is even spawned. Changed trees still take the normal replace
    // path so stale template files cannot be silently retained.
    if (sameTree(source, dest)) continue;
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(source, dest, { recursive: true });
  }
}
