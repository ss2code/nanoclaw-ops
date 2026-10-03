import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('memory SessionStart hook boot wiring', () => {
  const indexSrc = fs.readFileSync(path.join(import.meta.dir, 'index.ts'), 'utf-8');

  it('registers the shared hook on the real provider before entering the poll loop', () => {
    const registration = indexSrc.indexOf('registerMemorySessionHook(provider)');
    const polling = indexSrc.indexOf('await runPollLoop({');

    expect(indexSrc).toContain("import { registerMemorySessionHook } from './memory-session-hook.js'");
    expect(registration).toBeGreaterThan(0);
    expect(registration).toBeLessThan(polling);
  });
});
