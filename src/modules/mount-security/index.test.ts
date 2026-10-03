import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { allowlistPath } = vi.hoisted(() => ({
  allowlistPath: `/tmp/nanoclaw-mount-allowlist-${process.pid}.json`,
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, MOUNT_ALLOWLIST_PATH: allowlistPath };
});

import { resetMountAllowlistCacheForTesting, validateAdditionalMounts, validateMount } from './index.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mount-root-'));
const allowedDir = path.join(testRoot, 'documents');
const blockedDir = path.join(testRoot, 'credentials');

beforeEach(() => {
  fs.mkdirSync(allowedDir, { recursive: true });
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(
    allowlistPath,
    JSON.stringify({
      allowedRoots: [{ path: testRoot, allowReadWrite: true }],
      blockedPatterns: [],
    }),
  );
  resetMountAllowlistCacheForTesting();
});

afterEach(() => {
  resetMountAllowlistCacheForTesting();
  fs.rmSync(allowlistPath, { force: true });
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('validateMount', () => {
  it('accepts an existing path under an allowlisted root and preserves RW intent', () => {
    expect(validateMount({ hostPath: allowedDir, containerPath: 'documents', readonly: false })).toMatchObject({
      allowed: true,
      realHostPath: fs.realpathSync(allowedDir),
      resolvedContainerPath: 'documents',
      effectiveReadonly: false,
    });
  });

  it('rejects a missing host path instead of promising a persistent mount', () => {
    const result = validateMount({ hostPath: path.join(testRoot, 'does-not-exist'), containerPath: 'documents' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Host path does not exist');
  });

  it('rejects traversal and absolute container paths', () => {
    expect(validateMount({ hostPath: allowedDir, containerPath: '../outside' }).reason).toContain(
      'Invalid container path',
    );
    expect(validateMount({ hostPath: allowedDir, containerPath: '/tmp/outside' }).reason).toContain(
      'Invalid container path',
    );
  });

  it('applies default credential blocking even when the custom list is empty', () => {
    const result = validateMount({ hostPath: blockedDir, containerPath: 'credentials' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked pattern');
  });
});

describe('validateAdditionalMounts', () => {
  it('materializes only verified mounts under /workspace/extra', () => {
    const mounts = validateAdditionalMounts(
      [
        { hostPath: allowedDir, containerPath: 'documents', readonly: false },
        { hostPath: path.join(testRoot, 'missing'), containerPath: 'missing', readonly: false },
      ],
      'Jeeves',
    );

    expect(mounts).toEqual([
      {
        hostPath: fs.realpathSync(allowedDir),
        containerPath: '/workspace/extra/documents',
        readonly: false,
      },
    ]);
  });
});
