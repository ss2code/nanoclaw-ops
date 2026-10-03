import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  McpBridge,
  mcpToolName,
  normalizeToolSchema,
  searchMcpCatalog,
  type McpBridgeConnection,
  type PiExtensionApi,
} from './pi-mcp-bridge.js';
import type { McpServerConfig } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHealthFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pi-mcp-'));
  tempDirs.push(dir);
  return path.join(dir, 'health.json');
}

function fakePi(): PiExtensionApi & { tools: Map<string, any>; active: string[] } {
  const tools = new Map<string, any>();
  const active = ['read', 'write', 'edit', 'bash'];
  return {
    tools,
    active,
    registerTool(tool) {
      tools.set(tool.name, tool);
      if (!active.includes(tool.name)) active.push(tool.name);
    },
    getActiveTools: () => [...active],
    setActiveTools(names) {
      active.splice(0, active.length, ...names);
    },
    appendEntry() {},
    on() {},
  };
}

function connection(
  toolNames: string[],
  callTool: McpBridgeConnection['callTool'] = async () => ({ content: [{ type: 'text', text: 'ok' }] }),
): McpBridgeConnection {
  return {
    tools: toolNames.map((name) => ({
      name,
      description: `${name} description`,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    })),
    callTool,
    close: async () => {},
  };
}

describe('Pi MCP bridge', () => {
  it('preserves NanoClaw MCP names exactly and rejects unsafe names', () => {
    expect(mcpToolName('calendar', 'list-events')).toBe('mcp__calendar__list-events');
    expect(() => mcpToolName('bad name', 'list')).toThrow(/invalid MCP server name/i);
    expect(() => mcpToolName('mail', 'bad tool!')).toThrow(/invalid MCP tool name/i);
  });

  it('normalizes loose schemas into provider-safe object schemas without mutating the source', () => {
    const source = { properties: { q: { type: 'string' } }, required: ['q'], $schema: 'https://example.invalid' };
    expect(normalizeToolSchema(source)).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    expect(source).toHaveProperty('$schema');
  });

  it('searches names and descriptions deterministically with bounded results', () => {
    const catalog = [
      { piName: 'mcp__gmail__search_emails', serverName: 'gmail', toolName: 'search_emails', description: 'Find mail' },
      { piName: 'mcp__calendar__list-events', serverName: 'calendar', toolName: 'list-events', description: 'Calendar agenda' },
      { piName: 'mcp__tasks__list-tasks', serverName: 'tasks', toolName: 'list-tasks', description: 'Task board' },
    ];
    expect(searchMcpCatalog('calendar events', catalog, 1).map((entry) => entry.piName)).toEqual([
      'mcp__calendar__list-events',
    ]);
  });

  it('registers NanoClaw tools eagerly, defers external schemas behind ToolSearch, and activates matches additively', async () => {
    const servers: Record<string, McpServerConfig> = {
      nanoclaw: { command: 'nanoclaw-mcp' },
      gmail: { command: 'gmail-mcp' },
    };
    const bridge = new McpBridge({
      servers,
      healthFile: tempHealthFile(),
      connect: async (name) =>
        name === 'nanoclaw' ? connection(['send_message', 'list_tasks']) : connection(['search_emails', 'get_email']),
    });
    const pi = fakePi();

    await bridge.start(pi);

    expect(pi.tools.has('ToolSearch')).toBe(true);
    expect(pi.tools.has('mcp__nanoclaw__send_message')).toBe(true);
    expect(pi.tools.has('mcp__gmail__search_emails')).toBe(true);
    expect(pi.active).toContain('mcp__nanoclaw__send_message');
    expect(pi.active).not.toContain('mcp__gmail__search_emails');

    const result = await pi.tools.get('ToolSearch').execute('call-search', { query: 'find email' });
    expect(result.content[0].text).toContain('mcp__gmail__search_emails');
    expect(pi.active).toContain('mcp__gmail__search_emails');
    expect(pi.active).toContain('read');
  });

  it('forwards one call only, propagates cancellation, and never retries an unknown-outcome mutation', async () => {
    let calls = 0;
    let observedSignal: AbortSignal | undefined;
    const bridge = new McpBridge({
      servers: { calendar: { command: 'calendar-mcp' } },
      healthFile: tempHealthFile(),
      requiredServers: [],
      connect: async () =>
        connection(['create_event'], async (_name, _args, options) => {
          calls += 1;
          observedSignal = options?.signal;
          throw new Error('connection closed after request');
        }),
    });
    const pi = fakePi();
    await bridge.start(pi);
    const controller = new AbortController();

    await expect(
      pi.tools.get('mcp__calendar__create_event').execute('call-1', { title: 'scratch' }, controller.signal),
    ).rejects.toThrow(/connection closed after request/);
    expect(calls).toBe(1);
    expect(observedSignal).toBe(controller.signal);
  });

  it('degrades per optional server, fails closed for nanoclaw, and writes redacted health metadata', async () => {
    const healthFile = tempHealthFile();
    const secret = 'do-not-log-this-secret';
    const servers: Record<string, McpServerConfig> = {
      nanoclaw: { command: 'nanoclaw-mcp', env: { TOKEN: secret } },
      optional: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: secret } },
    };
    const bridge = new McpBridge({
      servers,
      healthFile,
      connect: async (name) => {
        if (name === 'optional') throw new Error(`unauthorized ${secret}`);
        return connection(['list_tasks']);
      },
    });

    await bridge.start(fakePi());
    const raw = fs.readFileSync(healthFile, 'utf8');
    const health = JSON.parse(raw);
    expect(raw).not.toContain(secret);
    expect(health.status).toBe('degraded');
    expect(health.servers.optional.status).toBe('error');

    const fatal = new McpBridge({
      servers: { nanoclaw: { command: 'missing' } },
      healthFile: tempHealthFile(),
      connect: async () => {
        throw new Error('spawn failed');
      },
    });
    await expect(fatal.start(fakePi())).rejects.toThrow(/required MCP server.*nanoclaw/i);
  });
});
