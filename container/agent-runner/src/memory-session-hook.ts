import { ensureMemoryScaffold } from './memory-scaffold.js';
import type { MemorySessionHook } from './providers/types.js';

export const MEMORY_SESSION_HOOK: MemorySessionHook = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
};

interface MemorySessionHookConsumer {
  readonly supportsNativeSlashCommands: boolean;
  registerMemorySessionHook?(hook: MemorySessionHook): void;
}

/**
 * Complete the provider-neutral SessionStart contract before the first query.
 * The scaffold is created only for providers that consume this hook, leaving
 * providers with native memory (Claude) untouched.
 */
export function registerMemorySessionHook(
  provider: MemorySessionHookConsumer,
  workspace = '/workspace/agent',
): boolean {
  if (typeof provider.registerMemorySessionHook !== 'function') return false;

  ensureMemoryScaffold(workspace);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return true;
}
