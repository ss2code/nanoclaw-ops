import { McpBridge, type PiExtensionApi } from './pi-mcp-bridge.js';
import type { McpServerConfig } from './types.js';

export default async function nanoclawPiMcpExtension(pi: PiExtensionApi): Promise<void> {
  const raw = process.env.NANOCLAW_PI_MCP_CONFIG || '{}';
  const servers = JSON.parse(raw) as Record<string, McpServerConfig>;
  const root = process.env.NANOCLAW_PI_OBSERVABILITY_DIR || '/workspace/pi-observability';
  const bridge = new McpBridge({
    servers,
    healthFile: `${root}/mcp-health.json`,
    eventsFile: `${root}/events.jsonl`,
  });
  // Pi binds action APIs such as getActiveTools/setActiveTools only after the
  // extension factory returns. session_start handlers run after that bind and
  // are awaited before the first model turn.
  pi.on('session_start', async () => bridge.start(pi));
}
