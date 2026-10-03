/**
 * nano-pvt-hub store behavior (Bun — this runs inside the container tree).
 *
 * hub.mjs is executed by BOTH runtimes (Node on the host, Bun in containers)
 * against a `--root`, so these tests double as the proof that the store logic
 * works under Bun. Ops Center's serving guards are tested separately in
 * ops-center/hub.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendTracker,
  getArtifact,
  indexDocs,
  parseTtl,
  publishArtifact,
  putArtifactData,
  readCatalog,
  rebuildCatalog,
  safeSlug,
  sweepExpired,
} from '../hub.mjs';

let root = '';
let src = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nano-pvt-hub-'));
  src = join(root, '_src.html');
  writeFileSync(src, '<h1>hello</h1>');
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

const manifestOf = (rec: { route: string; audience: string; id: string }) =>
  JSON.parse(readFileSync(join(root, rec.route, rec.audience, rec.id, 'manifest.json'), 'utf8'));

describe('safeSlug / parseTtl', () => {
  test('slugifies and rejects path-escaping values', () => {
    expect(safeSlug('My Doc')).toBe('my-doc');
    // ".." collapses to empty after stripping, so it cannot become a path segment.
    expect(() => safeSlug('..')).toThrow();
    expect(() => safeSlug('/')).toThrow();
    expect(() => safeSlug('')).toThrow();
  });

  test('treats unset/none as durable and parses real durations', () => {
    expect(parseTtl(undefined)).toBeNull();
    expect(parseTtl('none')).toBeNull();
    expect(parseTtl('30d')).toBe(30 * 86_400_000);
    expect(() => parseTtl('soon')).toThrow();
  });
});

describe('publish', () => {
  test('writes the artifact, its manifest, and the derived catalog', async () => {
    const rec = await publishArtifact(root, { kind: 'dashboard', title: 'Fleet', source: src });

    expect(rec.kind).toBe('dashboard');
    expect(rec.audience).toBe('shared');
    expect(rec.expiresAt).toBeNull(); // durable by default
    expect(readFileSync(join(root, rec.route, rec.audience, rec.id, 'index.html'), 'utf8')).toBe('<h1>hello</h1>');
    expect(manifestOf(rec).title).toBe('Fleet');

    const catalog = await readCatalog(root);
    expect(catalog.artifacts.map((a: { id: string }) => a.id)).toContain(rec.id);
    expect(rec.url).toBe(`/hub/dashboards/shared/${rec.id}/`);
  });

  test('keeps the source extension for non-HTML documents', async () => {
    const md = join(root, '_doc.md');
    writeFileSync(md, '# notes');
    const rec = await publishArtifact(root, { kind: 'agent-doc', title: 'Notes', source: md });
    expect(rec.entry).toBe('index.md');
    expect(rec.url.endsWith('/index.md')).toBe(true);
  });

  test('deduplicates identical content instead of publishing twice', async () => {
    const first = await publishArtifact(root, { kind: 'dashboard', title: 'Fleet', source: src });
    const second = await publishArtifact(root, { kind: 'dashboard', title: 'Fleet', source: src });
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test('replaces in place when the same --id is republished, preserving createdAt', async () => {
    const first = await publishArtifact(root, {
      kind: 'tracker',
      shape: 'status',
      id: 'fleet-health',
      title: 'Fleet Health',
      source: src,
    });
    writeFileSync(src, '<h1>updated</h1>');
    const second = await publishArtifact(root, {
      kind: 'tracker',
      shape: 'status',
      id: 'fleet-health',
      title: 'Fleet Health',
      source: src,
    });

    expect(second.replaced).toBe(true);
    expect(second.createdAt).toBe(first.createdAt);
    expect(readFileSync(join(root, 'trackers', 'shared', 'fleet-health', 'index.html'), 'utf8')).toBe(
      '<h1>updated</h1>',
    );
    const catalog = await readCatalog(root);
    expect(catalog.artifacts.filter((a: { id: string }) => a.id === 'fleet-health')).toHaveLength(1);
  });

  test('rejects unknown kinds, bad shapes, and unsupported source types', async () => {
    await expect(publishArtifact(root, { kind: 'nope', title: 'x', source: src })).rejects.toThrow();
    await expect(
      publishArtifact(root, { kind: 'dashboard', shape: 'log', title: 'x', source: src }),
    ).rejects.toThrow(/only valid for kind=tracker/);
    const bin = join(root, '_x.bin');
    writeFileSync(bin, 'x');
    await expect(publishArtifact(root, { kind: 'dashboard', title: 'x', source: bin })).rejects.toThrow();
  });

  test('refuses a symlinked source (bounded-source rule)', async () => {
    const link = join(root, '_link.html');
    symlinkSync(src, link);
    await expect(publishArtifact(root, { kind: 'dashboard', title: 'x', source: link })).rejects.toThrow(
      /non-symlink/,
    );
  });
});

describe('append (log trackers)', () => {
  test('creates on first append and accumulates one line per record', async () => {
    const rec = await appendTracker(root, { id: 'deploy-log', title: 'Deploy Log', record: '{"ok":true}' });
    expect(rec.shape).toBe('log');
    await appendTracker(root, { id: 'deploy-log', record: 'plain note' });

    const lines = readFileSync(join(root, 'trackers', 'shared', 'deploy-log', 'log.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].ok).toBe(true);
    expect(lines[1].text).toBe('plain note');
    expect(lines[0].ts).toBeTruthy(); // every record is timestamped
  });

  test('refuses to append to a tracker that is not a log', async () => {
    await publishArtifact(root, { kind: 'tracker', shape: 'status', id: 'status-page', title: 'S', source: src });
    await expect(appendTracker(root, { id: 'status-page', record: 'x' })).rejects.toThrow(/not a log/);
  });
});

describe('put-data', () => {
  test('attaches JSON data and bumps updatedAt', async () => {
    const rec = await publishArtifact(root, { kind: 'dashboard', id: 'spend', title: 'Spend', source: src });
    const data = join(root, '_rows.json');
    writeFileSync(data, JSON.stringify([{ a: 1 }]));

    await putArtifactData(root, { kind: 'dashboard', id: 'spend', name: 'rows', source: data });
    expect(JSON.parse(readFileSync(join(root, 'dashboards', 'shared', 'spend', 'data', 'rows.json'), 'utf8'))).toEqual([
      { a: 1 },
    ]);
    expect(manifestOf(rec).updatedAt >= rec.updatedAt).toBe(true);
  });

  test('rejects non-JSON data', async () => {
    await publishArtifact(root, { kind: 'dashboard', id: 'spend', title: 'Spend', source: src });
    const bad = join(root, '_bad.json');
    writeFileSync(bad, 'not json');
    await expect(putArtifactData(root, { kind: 'dashboard', id: 'spend', name: 'rows', source: bad })).rejects.toThrow();
  });
});

describe('sweep + catalog', () => {
  test('removes expired artifacts but keeps durable ones', async () => {
    const durable = await publishArtifact(root, { kind: 'dashboard', id: 'keep', title: 'Keep', source: src });
    const expiring = await publishArtifact(root, {
      kind: 'dashboard',
      id: 'drop',
      title: 'Drop',
      source: src,
      ttl: '30m',
    });

    const later = new Date(Date.now() + 60 * 60_000);
    const removed = await sweepExpired(root, later);
    expect(removed).toContain(`dashboard/shared/${expiring.id}`);

    const catalog = await readCatalog(root, later);
    const ids = catalog.artifacts.map((a: { id: string }) => a.id);
    expect(ids).toContain(durable.id);
    expect(ids).not.toContain(expiring.id);
  });

  test('rebuild is a pure function of the manifests, so concurrent writers converge', async () => {
    await publishArtifact(root, { kind: 'dashboard', id: 'a', title: 'A', source: src });
    await publishArtifact(root, { kind: 'agent-doc', id: 'b', title: 'B', source: src });

    const now = new Date();
    const first = await rebuildCatalog(root, now);
    const second = await rebuildCatalog(root, now);
    expect(second).toEqual(first);

    // A partial staging directory is never mistaken for a published artifact.
    mkdirSync(join(root, 'dashboards', 'shared', '.tmp-partial-abc'), { recursive: true });
    const third = await rebuildCatalog(root, now);
    expect(third.artifacts).toHaveLength(first.artifacts.length);
  });
});

describe('retrieval', () => {
  test('get returns the manifest and on-disk path', async () => {
    const rec = await publishArtifact(root, { kind: 'dashboard', id: 'spend', title: 'Spend', source: src });
    const got = await getArtifact(root, { kind: 'dashboard', audience: 'shared', id: 'spend' });
    expect(got.title).toBe('Spend');
    expect(got.path).toBe(join(root, 'dashboards', 'shared', rec.id));
  });

  test('indexDocs lists the read-only docs surface and never the private overlay', async () => {
    const docs = join(root, '_docs');
    mkdirSync(join(docs, 'local'), { recursive: true });
    mkdirSync(join(docs, 'guides'), { recursive: true });
    writeFileSync(join(docs, 'architecture.md'), '# a');
    writeFileSync(join(docs, 'guides', 'setup.md'), '# s');
    writeFileSync(join(docs, 'local', 'private.html'), '<h1>secret</h1>');
    symlinkSync(docs, join(root, 'nanoclaw-docs'));

    const listed = await indexDocs(root);
    expect(listed).toContain('nanoclaw-docs/architecture.md');
    expect(listed).toContain('nanoclaw-docs/guides/setup.md');
    expect(listed.some((p: string) => p.includes('local/'))).toBe(false);
  });
});
