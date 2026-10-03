import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireProcessLock, ProcessAlreadyRunningError } from './process-lock.js';

const tempDirs: string[] = [];

function lockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-process-lock-'));
  tempDirs.push(dir);
  return path.join(dir, 'nanoclaw.lock');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('acquireProcessLock', () => {
  it('allows one owner and releases only its own lock', () => {
    const path = lockPath();
    const first = acquireProcessLock(path, { pid: 101, now: () => '2026-07-25T00:00:00.000Z' });

    expect(() =>
      acquireProcessLock(path, {
        pid: 202,
        isProcessAlive: (pid) => pid === 101,
      }),
    ).toThrowError(ProcessAlreadyRunningError);

    first.release();
    expect(fs.existsSync(path)).toBe(false);
  });

  it('reclaims a lock whose recorded owner is dead', () => {
    const path = lockPath();
    const stale = acquireProcessLock(path, { pid: 101 });
    stale.release = () => undefined;

    const replacement = acquireProcessLock(path, {
      pid: 202,
      isProcessAlive: () => false,
      now: () => '2026-07-25T00:00:01.000Z',
    });

    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toMatchObject({ pid: 202 });
    replacement.release();
  });

  it('does not delete a corrupt lock without a known dead owner', () => {
    const path = lockPath();
    fs.writeFileSync(path, 'not-json\n', { mode: 0o600 });

    expect(() => acquireProcessLock(path, { pid: 202 })).toThrowError(ProcessAlreadyRunningError);
    expect(fs.readFileSync(path, 'utf8')).toBe('not-json\n');
  });
});
