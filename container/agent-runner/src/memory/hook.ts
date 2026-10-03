import fs from 'fs';
import path from 'path';

const DEFAULT_WORKSPACE = '/workspace/agent';

/**
 * SessionStart deliberately injects only the memory doctrine and top-level
 * index. Linked memories remain demand-loaded, preventing private leaf files
 * and an unbounded memory tree from being copied into every Codex session.
 */
export function buildMemorySessionContext(workspace = DEFAULT_WORKSPACE): string {
  const memoryDir = path.join(workspace, 'memory');
  const sections = [
    readIfPresent(path.join(memoryDir, 'system', 'definition.md')),
    readIfPresent(path.join(memoryDir, 'index.md')),
  ].filter((section): section is string => section !== null);

  return [
    'NanoClaw persistent memory context. Follow the definition, then use the index to load only relevant linked files.',
    ...sections,
  ].join('\n\n');
}

export function renderMemorySessionHookOutput(workspace = DEFAULT_WORKSPACE): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: buildMemorySessionContext(workspace),
    },
  });
}

function readIfPresent(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8').trim();
}

if (import.meta.main) {
  process.stdout.write(`${renderMemorySessionHookOutput()}\n`);
}
