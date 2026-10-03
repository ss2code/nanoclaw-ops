#!/usr/bin/env node
/**
 * nano-pvt-hub store + CLI — the single, dependency-free source of truth for
 * publishing and cataloging documents into the NanoClaw docs hub.
 *
 * WHY ONE FILE, TWO RUNTIMES: the host runs Node (pnpm) and agent containers run
 * Bun, and the two share NO modules (they talk only via the filesystem). This
 * file uses only `node:` built-ins (fs/path/crypto/url), so each runtime EXECUTES
 * it independently against a `--root` — the host against `data/hub`, a container
 * against its `/workspace/hub` mount. It is never imported across the boundary.
 *
 * The store uses per-artifact directories with a
 * `manifest.json` are the source of truth; `catalog.json` is a derived cache,
 * rewritten atomically (tmp + rename) so concurrent writers converge with no
 * lock. Publishing stages into a `.tmp-*` dir then atomically renames it into
 * place, so a partially-written artifact is never visible to readers.
 *
 * Layout under <root>:
 *   .hub-store                       marker (destructive ops refuse without it)
 *   catalog.json                     derived index (see rebuildCatalog)
 *   nanoclaw-docs -> ../../docs      read-only symlink surface (NOT cataloged)
 *   dashboards|trackers|agent-docs/<audience>/<id>/{manifest.json, index.*}
 *
 * Run `node hub.mjs help` (host) or `bun hub.mjs help` (container).
 */
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Document kind -> served route (subdirectory). nanoclaw-docs is separate. */
export const KIND_ROUTES = Object.freeze({
  dashboard: 'dashboards',
  tracker: 'trackers',
  'agent-doc': 'agent-docs',
});
/** Tracker shapes: status page (re-published/put-data), append log, or table. */
export const TRACKER_SHAPES = Object.freeze(['status', 'log', 'table']);
const STORE_MARKER = '.hub-store';
const MARKER_BODY = 'NanoClaw nano-pvt-hub artifact store\n';
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_DATA_BYTES = 4 * 1024 * 1024;
const LOG_ENTRY = 'log.ndjson';

/** Allowed publish source types -> the on-disk entry filename. */
const SOURCE_TYPES = Object.freeze({
  '.html': 'index.html',
  '.htm': 'index.html',
  '.md': 'index.md',
  '.markdown': 'index.md',
  '.txt': 'index.txt',
  '.json': 'index.json',
  '.csv': 'index.csv',
  '.svg': 'index.svg',
});

export function safeSlug(value, label = 'value') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return slug;
}

/**
 * Parse a TTL. Empty / "none" / "never" / "0" means DURABLE (null) — a document
 * repository is persistent, not ephemeral, so this is the default. Otherwise
 * "30m" | "24h" | "30d" | "4w", bounded to [1 minute, 366 days].
 */
export function parseTtl(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '' || v === 'none' || v === 'never' || v === '0') return null;
  const match = /^(\d+)(m|h|d|w)$/.exec(v);
  if (!match) throw new Error('TTL must be "none" or look like 30m, 24h, 30d, 4w');
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  const ttl = Number(match[1]) * unitMs;
  if (ttl < 60_000 || ttl > 366 * 86_400_000) {
    throw new Error('TTL must be between one minute and 366 days');
  }
  return ttl;
}

function notExpired(record, now) {
  return record.expiresAt == null || new Date(record.expiresAt) > now;
}

/** Reject any path that resolves outside `root` (traversal / symlink guard). */
function assertInside(root, target) {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (absoluteTarget !== absoluteRoot && !absoluteTarget.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error('Resolved path escapes the hub store');
  }
  return absoluteTarget;
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  await rename(temporary, path);
}

export async function ensureStore(root) {
  await mkdir(root, { recursive: true, mode: 0o755 });
  const marker = join(root, STORE_MARKER);
  try {
    await stat(marker);
  } catch {
    await writeFile(marker, MARKER_BODY, { encoding: 'utf8', mode: 0o644 });
  }
}

async function assertStore(root) {
  const body = await readFile(join(root, STORE_MARKER), 'utf8');
  if (body !== MARKER_BODY) throw new Error(`Refusing operation: invalid store marker at ${join(root, STORE_MARKER)}`);
}

async function readManifest(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function artifactManifests(root) {
  await ensureStore(root);
  const records = [];
  for (const [kind, route] of Object.entries(KIND_ROUTES)) {
    const routeRoot = join(root, route);
    let audiences = [];
    try {
      audiences = await readdir(routeRoot, { withFileTypes: true });
    } catch {
      /* route not created yet */
    }
    for (const a of audiences.filter((e) => e.isDirectory() && !e.name.startsWith('.'))) {
      const audienceRoot = join(routeRoot, a.name);
      const artifacts = await readdir(audienceRoot, { withFileTypes: true });
      for (const art of artifacts.filter((e) => e.isDirectory() && !e.name.startsWith('.'))) {
        try {
          const manifest = await readManifest(join(audienceRoot, art.name, 'manifest.json'));
          if (manifest.kind === kind) records.push(manifest);
        } catch {
          // A partial staging directory (no valid manifest) is not an artifact.
        }
      }
    }
  }
  return records;
}

function publicRecord(manifest) {
  const route = KIND_ROUTES[manifest.kind];
  const base = `/hub/${route}/${manifest.audience}/${manifest.id}/`;
  const entry = manifest.entry || 'index.html';
  const record = {
    id: manifest.id,
    kind: manifest.kind,
    route,
    audience: manifest.audience,
    series: manifest.series,
    title: manifest.title,
    summary: manifest.summary,
    sensitivity: manifest.sensitivity,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    expiresAt: manifest.expiresAt ?? null,
    contentHash: manifest.contentHash,
    entry,
    url: entry === 'index.html' ? base : base + entry,
  };
  if (manifest.shape) record.shape = manifest.shape;
  return record;
}

export async function rebuildCatalog(root, now = new Date()) {
  const records = (await artifactManifests(root))
    .filter((r) => notExpired(r, now))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(publicRecord);
  const catalog = { version: 1, generatedAt: now.toISOString(), artifacts: records };
  await writeJsonAtomic(join(root, 'catalog.json'), catalog);
  return catalog;
}

export async function readCatalog(root, now = new Date()) {
  await ensureStore(root);
  try {
    const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
    return { ...catalog, artifacts: catalog.artifacts.filter((r) => notExpired(r, now)) };
  } catch {
    return rebuildCatalog(root, now);
  }
}

function validateShape(kind, shape) {
  if (!shape) return undefined;
  if (kind !== 'tracker') throw new Error('shape is only valid for kind=tracker');
  if (!TRACKER_SHAPES.includes(shape)) throw new Error(`shape must be one of: ${TRACKER_SHAPES.join(', ')}`);
  return shape;
}

async function readSource(source, { maxBytes, requireJson } = {}) {
  const abs = resolve(source || '');
  const st = await lstat(abs);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('source must be a regular, non-symlink file');
  if (maxBytes && st.size > maxBytes) throw new Error(`source exceeds the ${Math.round(maxBytes / 1048576)} MiB limit`);
  const body = await readFile(abs);
  if (requireJson) JSON.parse(body.toString('utf8'));
  return { abs, body };
}

/** Atomically replace an existing artifact dir with a freshly staged one. */
async function swapDir(staging, target) {
  const trash = `${target}.old-${randomBytes(4).toString('hex')}`;
  await rename(target, trash);
  try {
    await rename(staging, target);
  } catch (error) {
    await rename(trash, target).catch(() => {});
    throw error;
  }
  await rm(trash, { recursive: true, force: true });
}

/**
 * Publish (or, with an explicit --id that already exists, replace) an artifact.
 * The source is a regular file of an allowed type; it becomes index.<ext>.
 */
export async function publishArtifact(root, options, now = new Date()) {
  await ensureStore(root);
  const kind = String(options.kind || '');
  const route = KIND_ROUTES[kind];
  if (!route) throw new Error(`Unsupported kind: ${kind} (use ${Object.keys(KIND_ROUTES).join(' | ')})`);
  const audience = safeSlug(options.audience || 'shared', 'audience');
  const series = safeSlug(options.series || kind, 'series');
  const title = String(options.title || '').trim();
  if (!title || title.length > 160) throw new Error('title is required and must be at most 160 characters');
  const summary = String(options.summary || '').trim().slice(0, 500);
  const shape = validateShape(kind, options.shape);

  const ext = extname(String(options.source || '')).toLowerCase();
  const entry = SOURCE_TYPES[ext];
  if (!entry) throw new Error(`unsupported source type: ${ext || '(none)'} (allowed: ${Object.keys(SOURCE_TYPES).join(' ')})`);
  const { abs: source, body } = await readSource(options.source, { maxBytes: MAX_ARTIFACT_BYTES });
  const contentHash = createHash('sha256').update(body).digest('hex');

  const explicitId = options.id != null && options.id !== '';
  if (!explicitId) {
    const dup = (await artifactManifests(root)).find(
      (r) => r.kind === kind && r.audience === audience && r.series === series && r.contentHash === contentHash && notExpired(r, now),
    );
    if (dup) return { ...publicRecord(dup), deduplicated: true };
  }

  const ttlMs = parseTtl(options.ttl);
  const createdAt = now.toISOString();
  const expiresAt = ttlMs == null ? null : new Date(now.getTime() + ttlMs).toISOString();
  const timestamp = createdAt.replace(/\D/g, '').slice(0, 14);
  const id = safeSlug(explicitId ? options.id : `${series}-${timestamp}-${randomBytes(3).toString('hex')}`, 'id');

  const audienceRoot = assertInside(root, join(root, route, audience));
  await mkdir(audienceRoot, { recursive: true, mode: 0o755 });
  const target = assertInside(audienceRoot, join(audienceRoot, id));
  const exists = await stat(target).then(() => true).catch(() => false);
  if (exists && !explicitId) throw new Error(`artifact already exists: ${kind}/${audience}/${id}`);

  const staging = assertInside(audienceRoot, join(audienceRoot, `.tmp-${id}-${randomBytes(4).toString('hex')}`));
  await mkdir(staging, { mode: 0o755 });
  try {
    await copyFile(source, join(staging, entry));
    const prior = exists ? await readManifest(join(target, 'manifest.json')).catch(() => null) : null;
    const manifest = {
      version: 1,
      id,
      kind,
      audience,
      series,
      title,
      summary,
      ...(shape ? { shape } : {}),
      sensitivity: options.sensitivity || 'private',
      createdAt: prior?.createdAt || createdAt,
      updatedAt: createdAt,
      expiresAt,
      contentHash,
      entry,
      sourceName: basename(source),
    };
    await writeJsonAtomic(join(staging, 'manifest.json'), manifest);
    if (exists) await swapDir(staging, target);
    else await rename(staging, target);
    await rebuildCatalog(root, now);
    return { ...publicRecord(manifest), replaced: exists };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Attach/replace a named JSON data file on an existing artifact (e.g. a dashboard's data feed). */
export async function putArtifactData(root, options, now = new Date()) {
  await assertStore(root);
  const route = KIND_ROUTES[options.kind];
  if (!route) throw new Error(`Unsupported kind: ${options.kind}`);
  const audience = safeSlug(options.audience || 'shared', 'audience');
  const id = safeSlug(options.id, 'id');
  const name = safeSlug(String(options.name || '').replace(/\.json$/i, ''), 'data name');
  const { body } = await readSource(options.source, { maxBytes: MAX_DATA_BYTES, requireJson: true });
  const artifactRoot = assertInside(root, join(root, route, audience, id));
  const manifestPath = join(artifactRoot, 'manifest.json');
  const manifest = await readManifest(manifestPath);
  if (!notExpired(manifest, now)) throw new Error('cannot update an expired artifact');
  const dataRoot = join(artifactRoot, 'data');
  await mkdir(dataRoot, { recursive: true, mode: 0o755 });
  await writeJsonAtomic(join(dataRoot, `${name}.json`), JSON.parse(body.toString('utf8')));
  manifest.updatedAt = now.toISOString();
  await writeJsonAtomic(manifestPath, manifest);
  await rebuildCatalog(root, now);
  return publicRecord(manifest);
}

/**
 * Append a record to a log-shaped tracker, creating it on first append. `record`
 * is JSON (stored as-is, stamped with `ts`) or free text (wrapped as {ts,text}).
 */
export async function appendTracker(root, options, now = new Date()) {
  await ensureStore(root);
  const audience = safeSlug(options.audience || 'shared', 'audience');
  const id = safeSlug(options.id, 'id');
  const artifactRoot = assertInside(root, join(root, 'trackers', audience, id));
  const manifestPath = join(artifactRoot, 'manifest.json');
  let manifest = await readManifest(manifestPath).catch(() => null);
  if (!manifest) {
    const title = String(options.title || id).trim().slice(0, 160);
    await mkdir(artifactRoot, { recursive: true, mode: 0o755 });
    manifest = {
      version: 1,
      id,
      kind: 'tracker',
      audience,
      series: safeSlug(options.series || 'log', 'series'),
      title,
      summary: String(options.summary || '').trim().slice(0, 500),
      shape: 'log',
      sensitivity: options.sensitivity || 'private',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: parseTtl(options.ttl) == null ? null : new Date(now.getTime() + parseTtl(options.ttl)).toISOString(),
      entry: LOG_ENTRY,
    };
  } else if (manifest.shape !== 'log') {
    throw new Error(`tracker ${id} is not a log (shape=${manifest.shape || 'unset'})`);
  }
  let payload;
  try {
    const parsed = JSON.parse(String(options.record));
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    payload = { text: String(options.record ?? '') };
  }
  const line = JSON.stringify({ ts: now.toISOString(), ...payload });
  if (line.length > 8192) throw new Error('append record too large (keep it a single small line)');
  await appendFile(join(artifactRoot, LOG_ENTRY), `${line}\n`, { encoding: 'utf8', mode: 0o644 });
  manifest.updatedAt = now.toISOString();
  await writeJsonAtomic(manifestPath, manifest);
  await rebuildCatalog(root, now);
  return publicRecord(manifest);
}

export async function sweepExpired(root, now = new Date()) {
  await assertStore(root);
  const removed = [];
  for (const manifest of await artifactManifests(root)) {
    if (notExpired(manifest, now)) continue;
    const route = KIND_ROUTES[manifest.kind];
    const target = assertInside(root, join(root, route, safeSlug(manifest.audience), safeSlug(manifest.id)));
    await rm(target, { recursive: true, force: true });
    removed.push(`${manifest.kind}/${manifest.audience}/${manifest.id}`);
  }
  await rebuildCatalog(root, now);
  return removed;
}

export async function getArtifact(root, { kind, audience, id }) {
  const route = KIND_ROUTES[kind];
  if (!route) throw new Error(`Unsupported kind: ${kind}`);
  const artifactRoot = assertInside(root, join(root, route, safeSlug(audience || 'shared'), safeSlug(id)));
  const manifest = await readManifest(join(artifactRoot, 'manifest.json'));
  return { ...publicRecord(manifest), path: artifactRoot };
}

/** List files under the read-only nanoclaw-docs surface (excludes local/). */
export async function indexDocs(root) {
  const docsRoot = join(root, 'nanoclaw-docs');
  const out = [];
  async function walk(dir, rel) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      // A directory entry may itself be a symlink; resolve type via stat.
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        isDir = await stat(join(dir, e.name)).then((s) => s.isDirectory()).catch(() => false);
      }
      if (isDir) {
        if (childRel === 'local' || childRel.startsWith('local/')) continue; // private overlay
        await walk(join(dir, e.name), childRel);
      } else if (/\.(html?|md|markdown|txt|pdf|json|csv|svg|png|jpe?g|webp|gif)$/i.test(e.name)) {
        out.push(`nanoclaw-docs/${childRel}`);
      }
    }
  }
  await walk(docsRoot, '');
  return out.sort();
}

// ─────────────────────────────── CLI ───────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

const HELP = `nano-pvt-hub — document hub publisher

Usage (host):      node hub.mjs <command> --root data/hub [flags]
Usage (container): bun /app/skills/nano-pvt-hub/hub.mjs <command> --root /workspace/hub [flags]

Commands:
  publish   --kind dashboard|tracker|agent-doc --title <t> --source <file>
            [--audience <a=shared>] [--series <s>] [--summary <text>]
            [--shape status|log|table] [--ttl none|30d] [--id <stable-id>]
              Publish a document. Source may be .html .md .txt .json .csv .svg.
              Durable by default; pass --ttl to expire. Re-run with the same
              --id to replace in place (e.g. a status page).
  put-data  --kind <k> --audience <a> --id <id> --name <n> --source <file.json>
              Attach/replace a JSON data file on an existing artifact.
  append    --id <id> --record <json|text> [--audience <a>] [--title <t>] [--ttl none]
              Append a line to a log-shaped tracker (creates it on first append).
  list      [--kind <k>] [--json]        Human (or JSON) listing of the catalog.
  catalog                                Print catalog.json (rebuilt from manifests).
  get       --kind <k> --audience <a> --id <id>   Print one artifact's manifest + path.
  index     [--docs]                     JSON for agents: {artifacts, docs}. --docs = docs only.
  rebuild                                Regenerate catalog.json from manifests.
  sweep                                  Delete artifacts past their expiry.

Every command needs --root <hub dir>.`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'help';
  if (command === 'help' || flags.help) {
    console.log(HELP);
    return;
  }
  const root = resolve(String(flags.root || ''));
  if (!flags.root) throw new Error('--root <hub dir> is required');

  switch (command) {
    case 'publish':
      console.log(JSON.stringify(await publishArtifact(root, flags), null, 2));
      break;
    case 'put-data':
      console.log(JSON.stringify(await putArtifactData(root, flags), null, 2));
      break;
    case 'append':
      console.log(JSON.stringify(await appendTracker(root, flags), null, 2));
      break;
    case 'list': {
      const catalog = await readCatalog(root);
      const rows = catalog.artifacts.filter((r) => !flags.kind || r.kind === flags.kind);
      if (flags.json) console.log(JSON.stringify(rows, null, 2));
      else
        console.log(
          rows.map((r) => `${r.kind}\t${r.audience}\t${r.expiresAt || 'durable'}\t${r.url}\t${r.title}`).join('\n') ||
            '(empty)',
        );
      break;
    }
    case 'catalog':
      console.log(JSON.stringify(await rebuildCatalog(root), null, 2));
      break;
    case 'get':
      console.log(JSON.stringify(await getArtifact(root, flags), null, 2));
      break;
    case 'index': {
      const docs = await indexDocs(root);
      if (flags.docs) console.log(JSON.stringify({ docs }, null, 2));
      else {
        const catalog = await readCatalog(root);
        console.log(JSON.stringify({ artifacts: catalog.artifacts, docs }, null, 2));
      }
      break;
    }
    case 'rebuild':
      console.log(JSON.stringify(await rebuildCatalog(root), null, 2));
      break;
    case 'sweep':
      console.log(JSON.stringify({ ok: true, removed: await sweepExpired(root) }, null, 2));
      break;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

// Only run the CLI when executed directly — NOT when imported by tests. Node and
// Bun both resolve module symlinks, so the realpath comparison holds even when
// invoked through the host skill's symlinked copy.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
