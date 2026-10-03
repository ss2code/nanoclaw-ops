import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { readEnvFile } from './env.js';

describe('readEnvFile', () => {
  it('can read an explicit non-secret runtime profile file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runtime-env-'));
    fs.writeFileSync(path.join(dir, '.env.runtime'), 'NANOCLAW_RUNTIME_PROFILE=development\nIGNORED=secret\n');
    expect(readEnvFile(['NANOCLAW_RUNTIME_PROFILE'], '.env.runtime', dir)).toEqual({
      NANOCLAW_RUNTIME_PROFILE: 'development',
    });
  });
});
