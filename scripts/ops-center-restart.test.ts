import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';

const ROOT = process.cwd();
const HELPER = path.join(ROOT, 'bin', 'nanoclaw-ops-restart');

describe('bin/nanoclaw-ops-restart', () => {
  it("restarts this checkout's macOS Ops Center LaunchAgent without a hard-coded slug", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ops-restart-test-'));
    const capture = path.join(tempDir, 'launchctl-args');
    const fakeLaunchctl = path.join(tempDir, 'launchctl');
    const fakeUname = path.join(tempDir, 'uname');
    try {
      fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NANOCLAW_TEST_CAPTURE"\n', { mode: 0o755 });
      fs.writeFileSync(fakeUname, '#!/bin/sh\nprintf "Darwin\\n"\n', { mode: 0o755 });

      const result = spawnSync('bash', [HELPER], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ''}`,
          LAUNCHCTL_BIN: fakeLaunchctl,
          NANOCLAW_TEST_CAPTURE: capture,
        },
      });

      expect(result.status).toBe(0);
      const slug = crypto.createHash('sha1').update(ROOT).digest('hex').slice(0, 8);
      expect(fs.readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
        'kickstart',
        '-k',
        `gui/${process.getuid?.() ?? 0}/com.nanoclaw.opscenter-${slug}`,
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
