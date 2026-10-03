import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initTestWorld, runAs } from './harness';

const worlds: string[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) fs.rmSync(world, { recursive: true, force: true });
});

function world(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-resource-bundle-'));
  worlds.push(root);
  initTestWorld(root);
  return root;
}

function ingest(root: string): void {
  const document = path.join(import.meta.dir, 'fixtures', 'assessment-bank-base-doc.md');
  const staged = runAs(root, 'tutor-control', [
    'ingestion', 'propose', '--document', document, '--graph', 'Bundle_Mathematics_KG',
    '--scope-type', 'chapter', '--scope-label', 'Patterns', '--json',
  ]);
  const proposal = JSON.parse(staged.stdout);
  expect(runAs(root, 'tutor-control', [
    'ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json',
  ]).exitCode).toBe(0);
}

describe('instruction resource bundles', () => {
  test('promotes HTML, PDF, and text variants together with an accessible fallback', () => {
    const root = world();
    ingest(root);
    const bundleDir = path.join(root, 'artifacts', 'lesson-1');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'index.html'), '<!doctype html><html><body><h1>Number patterns</h1><script>alert(1)</script></body></html>');
    fs.writeFileSync(path.join(bundleDir, 'lesson.pdf'), '%PDF-1.4 synthetic lesson');
    fs.writeFileSync(path.join(bundleDir, 'lesson.md'), '# Number patterns\n\nA sequence follows a rule.');
    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify({ title: 'Number patterns' }));
    const registered = runAs(root, 'tutor-control', [
      'admin', 'instruction-register', '--concept', 'C01', '--kind', 'lesson', '--title', 'Number patterns lesson',
      '--artifact', path.join(bundleDir, 'index.html'), '--artifacts', JSON.stringify([
        path.join(bundleDir, 'index.html'), path.join(bundleDir, 'lesson.pdf'), path.join(bundleDir, 'lesson.md'), path.join(bundleDir, 'manifest.json'),
      ]), '--text-alternative', 'A sequence follows a rule. This lesson explains how to find the rule.',
      '--tags', '["lesson","math"]', '--provenance', '["assessment-bank-base-doc"]', '--idempotency', 'bundle-1', '--json',
    ]);
    expect(registered.exitCode).toBe(0);
    const resource = JSON.parse(registered.stdout).resource;
    expect(resource.artifact_paths_json).toBeTruthy();

    const catalogue = JSON.parse(runAs(root, 'student-a', ['instruction', 'list', '--concept', 'C01', '--json']).stdout);
    const item = catalogue.items.find((entry: { id: string }) => entry.id === resource.id);
    expect(item).toMatchObject({ kind: 'lesson', generated: true, format: expect.arrayContaining(['HTML', 'PDF', 'text alternative']) });
    expect(item.artifact_paths).toHaveLength(4);
    expect(item.preview_path.toLowerCase()).toEndWith(`${path.sep}index.html`);
    expect(fs.readFileSync(item.preview_path, 'utf8')).not.toContain('<script>');
    for (const artifact of item.artifact_paths) expect(fs.existsSync(artifact)).toBe(true);
  });
});
