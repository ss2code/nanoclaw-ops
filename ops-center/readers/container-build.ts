/**
 * "What the Docker is built from" for the per-container (group) page.
 *
 * Three sources, all read-only:
 *   - The shared image recipe (`container/Dockerfile`) — base image, pinned CLI
 *     versions, pip pins, and apt packages. Same for every group; parsed fresh
 *     each call (the file is tiny).
 *   - The shared global-CLI manifest (`container/cli-tools.json`) — exact npm
 *     pins for tools such as the Pi runtime, also common to every group.
 *   - The group's own Claude Code settings (`settings.json`) — which PreToolUse
 *     hooks are wired, so we can surface whether opt-in tools like rtk are
 *     actually active for THIS group.
 */
import fs from 'fs';
import path from 'path';
import { ROOT, PATHS } from '../config.js';

const DOCKERFILE = path.join(ROOT, 'container', 'Dockerfile');
const CLI_TOOLS_MANIFEST = path.join(ROOT, 'container', 'cli-tools.json');

export interface BakedTool {
  name: string;
  version: string;
}

export interface ImageBuildManifest {
  dockerfilePath: string;
  baseImage: string | null;
  bakedTools: BakedTool[];
  pythonPackages: BakedTool[];
  aptPackages: string[];
  error?: string;
}

/** Human labels for known `ARG <X>_VERSION` pins; falls back to lowercased-kebab. */
const TOOL_LABELS: Record<string, string> = {
  CLAUDE_CODE: 'claude-code',
  AGENT_BROWSER: 'agent-browser',
  VERCEL: 'vercel',
  BUN: 'bun',
  PNPM: 'pnpm',
  RTK: 'rtk',
};

/** Human labels for packages installed by the shared global-CLI manifest. */
const CLI_TOOL_LABELS: Record<string, string> = {
  '@anthropic-ai/claude-code': 'claude-code',
  '@cocal/google-calendar-mcp': 'google-calendar-mcp',
  '@earendil-works/pi-coding-agent': 'pi',
  '@gongrzhe/server-gmail-autoauth-mcp': 'gmail-mcp',
  '@openai/codex': 'codex',
  '@scottie-will/google-tasks-mcp': 'google-tasks-mcp',
  'agent-browser': 'agent-browser',
  'opencode-ai': 'opencode',
  vercel: 'vercel',
  'zod-to-json-schema': 'zod-to-json-schema',
};

const APT_NOISE = new Set([
  'apt-get',
  'install',
  'update',
  'if',
  'then',
  'fi',
  'else',
  'rm',
  'true',
  'false',
]);

/**
 * Parse the shared Dockerfile into a build manifest. Best-effort and defensive:
 * any parse failure returns an `error` string rather than throwing, so the card
 * degrades to a note instead of blanking the page.
 */
export function readImageBuildManifest(): ImageBuildManifest {
  const base: ImageBuildManifest = {
    dockerfilePath: path.relative(ROOT, DOCKERFILE),
    baseImage: null,
    bakedTools: [],
    pythonPackages: [],
    aptPackages: [],
  };
  let text: string;
  try {
    text = fs.readFileSync(DOCKERFILE, 'utf-8');
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  // Base image: last FROM wins (final runtime stage in a multi-stage build).
  const froms = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  base.baseImage = froms.length ? froms[froms.length - 1] : null;

  // Pinned CLI versions: `ARG <NAME>_VERSION=<value>`.
  for (const m of text.matchAll(/^ARG\s+([A-Z0-9_]+)_VERSION=(\S+)/gm)) {
    const key = m[1];
    base.bakedTools.push({ name: TOOL_LABELS[key] ?? key.toLowerCase().replace(/_/g, '-'), version: m[2] });
  }

  // Global Node CLIs are installed from this manifest rather than as Dockerfile
  // ARGs. Include them in the same card so the deployed image explains the
  // actual runtime surface, including the Pi harness version.
  try {
    const manifest = JSON.parse(fs.readFileSync(CLI_TOOLS_MANIFEST, 'utf8')) as unknown;
    if (!Array.isArray(manifest)) throw new Error('manifest is not an array');
    for (const item of manifest) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as { name?: unknown; version?: unknown };
      const name = typeof entry.name === 'string' ? entry.name : null;
      const version = typeof entry.version === 'string' ? entry.version : null;
      if (!name || !version) continue;
      const label = CLI_TOOL_LABELS[name] ?? name;
      if (!base.bakedTools.some((tool) => tool.name === label)) base.bakedTools.push({ name: label, version });
    }
  } catch (err) {
    base.error = err instanceof Error ? `cli-tools.json: ${err.message}` : `cli-tools.json: ${String(err)}`;
  }

  // Pinned pip packages: `"name==version"` anywhere (finance runtime block).
  for (const m of text.matchAll(/"([a-zA-Z0-9_.-]+)==([0-9][^"]*)"/g)) {
    base.pythonPackages.push({ name: m[1], version: m[2] });
  }

  // apt packages: gather the backslash-continued lines of the apt-get install
  // RUN, then keep package-looking tokens.
  const aptIdx = text.indexOf('apt-get install');
  if (aptIdx !== -1) {
    const tail = text.slice(aptIdx);
    const end = tail.search(/rm -rf \/var\/lib\/apt/);
    const block = end === -1 ? tail.slice(0, 2000) : tail.slice(0, end);
    const seen = new Set<string>();
    for (const tok of block.split(/\s+/)) {
      if (/^[a-z][a-z0-9.+-]+$/.test(tok) && !APT_NOISE.has(tok) && !seen.has(tok)) {
        seen.add(tok);
        base.aptPackages.push(tok);
      }
    }
  }

  return base;
}

export interface PreToolUseHook {
  matcher: string;
  commands: string[];
}

export interface GroupRuntimeHooks {
  settingsPath: string;
  exists: boolean;
  preToolUse: PreToolUseHook[];
  /** rtk token-compression proxy is wired as a Bash PreToolUse hook. */
  rtkActive: boolean;
  error?: string;
}

/**
 * Read a group's Claude Code settings.json to report which PreToolUse hooks are
 * wired — used to show whether opt-in tools (rtk) are active for this group.
 */
export function readGroupRuntimeHooks(groupId: string): GroupRuntimeHooks {
  const settingsPath = path.join(PATHS.sessionsDir, groupId, '.claude-shared', 'settings.json');
  const out: GroupRuntimeHooks = { settingsPath: path.relative(ROOT, settingsPath), exists: false, preToolUse: [], rtkActive: false };
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8');
    out.exists = true;
  } catch {
    return out; // no settings yet — group never spawned
  }
  try {
    const settings = JSON.parse(raw) as { hooks?: { PreToolUse?: unknown } };
    const pre = Array.isArray(settings.hooks?.PreToolUse) ? (settings.hooks!.PreToolUse as any[]) : [];
    for (const entry of pre) {
      const commands = Array.isArray(entry?.hooks)
        ? entry.hooks.map((h: any) => String(h?.command ?? '')).filter(Boolean)
        : [];
      out.preToolUse.push({ matcher: String(entry?.matcher ?? '*'), commands });
      if (commands.some((c: string) => /(^|\/|\s)rtk\s+hook\b/.test(c))) out.rtkActive = true;
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}
