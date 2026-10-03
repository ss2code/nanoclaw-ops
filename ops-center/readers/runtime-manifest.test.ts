import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readRuntimeManifest } from './runtime-manifest.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime manifest reader', () => {
  it('reads valid provenance and ignores malformed files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runtime-manifest-'));
    roots.push(root);
    expect(readRuntimeManifest(root)).toBeNull();
    fs.writeFileSync(
      path.join(root, 'runtime-manifest.json'),
      JSON.stringify({
        schema: 2,
        generated_at: '2026-08-20T10:00:00.000Z',
        image: 'nanoclaw-agent:test',
        image_fingerprint: 'a'.repeat(64),
        agent_runner_fingerprint: 'b'.repeat(64),
        skills_fingerprint: 'c'.repeat(64),
        runtime_fingerprint: 'd'.repeat(64),
      }),
    );
    expect(readRuntimeManifest(root)?.runtime_fingerprint).toHaveLength(64);
    fs.writeFileSync(
      path.join(root, 'runtime-manifest.json'),
      JSON.stringify({
        schema: 1,
        generated_at: '2026-08-20T10:00:00.000Z',
        image: 'nanoclaw-agent:test',
        image_fingerprint: 'a'.repeat(64),
        agent_runner_fingerprint: 'b'.repeat(64),
        skills_fingerprint: 'c'.repeat(64),
      }),
    );
    expect(readRuntimeManifest(root)?.image_fingerprint).toHaveLength(64);
    fs.writeFileSync(path.join(root, 'runtime-manifest.json'), '{bad');
    expect(readRuntimeManifest(root)).toBeNull();
  });
});
