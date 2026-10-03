import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { resolveRuntimeProfile } from './runtime-profile.js';

describe('resolveRuntimeProfile', () => {
  it('keeps background scheduling enabled by default and in production', () => {
    expect(resolveRuntimeProfile(undefined)).toEqual({ name: 'production', backgroundWorkEnabled: true });
    expect(resolveRuntimeProfile('production')).toEqual({ name: 'production', backgroundWorkEnabled: true });
  });

  it('disables copied schedules and recurrence in local development', () => {
    expect(resolveRuntimeProfile('development')).toEqual({ name: 'development', backgroundWorkEnabled: false });
  });

  it('rejects unknown profiles instead of silently running production work', () => {
    expect(() => resolveRuntimeProfile('prodution')).toThrow(/NANOCLAW_RUNTIME_PROFILE/);
  });
});

describe('runtime profile wiring', () => {
  it('loads machine-specific non-secret controls from .env.runtime', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf8');
    expect(source).toContain("'.env.runtime'");
    expect(source).toContain("process.env.NODE_ENV === 'test'");
  });
});
