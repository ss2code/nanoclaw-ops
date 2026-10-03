import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildMemorySessionContext, renderMemorySessionHookOutput } from './memory/hook.js';
import { MEMORY_SESSION_HOOK, registerMemorySessionHook } from './memory-session-hook.js';

describe('shared memory SessionStart hook', () => {
  it('registers the stable command and creates the scaffold before Codex starts', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-hook-'));
    let registered: unknown;
    try {
      const provider = {
        supportsNativeSlashCommands: false,
        registerMemorySessionHook(hook: unknown) {
          registered = hook;
        },
      };

      expect(registerMemorySessionHook(provider, base)).toBe(true);
      expect(registered).toEqual(MEMORY_SESSION_HOOK);
      expect(MEMORY_SESSION_HOOK).toEqual({
        command: 'bun /app/src/memory/hook.ts',
        legacyCommands: ['bun /app/src/memory-hook.ts'],
        sources: ['startup', 'clear', 'compact'],
      });
      expect(fs.existsSync(path.join(base, 'memory', 'index.md'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'system', 'definition.md'))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('does nothing for providers that do not consume the hook contract', () => {
    expect(registerMemorySessionHook({ supportsNativeSlashCommands: false }, '/unused')).toBe(false);
  });

  it('emits valid Codex SessionStart additionalContext from only the definition and top index', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-hook-'));
    try {
      fs.mkdirSync(path.join(base, 'memory', 'system'), { recursive: true });
      fs.writeFileSync(path.join(base, 'memory', 'system', 'definition.md'), '# Definition\nRemember carefully.\n');
      fs.writeFileSync(path.join(base, 'memory', 'index.md'), '# Index\n- [Project](memories/project.md)\n');
      fs.mkdirSync(path.join(base, 'memory', 'memories'), { recursive: true });
      fs.writeFileSync(path.join(base, 'memory', 'memories', 'project.md'), 'PRIVATE DETAIL\n');

      const context = buildMemorySessionContext(base);
      expect(context).toContain('# Definition');
      expect(context).toContain('# Index');
      expect(context).not.toContain('PRIVATE DETAIL');

      const output = JSON.parse(renderMemorySessionHookOutput(base)) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(output.hookSpecificOutput.additionalContext).toBe(context);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
