import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { McpServerConfig } from './types.js';

type JsonSchema = Record<string, unknown>;

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

export interface PiExtensionApi {
  registerTool(tool: PiToolDefinition): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(type: string, data?: unknown): void;
  on(event: string, handler: (...args: any[]) => unknown): void;
}

export interface McpBridgeConnection {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ content?: unknown[]; isError?: boolean; [key: string]: unknown }>;
  close(): Promise<void>;
}

export interface McpCatalogEntry {
  piName: string;
  serverName: string;
  toolName: string;
  description: string;
}

interface ServerHealth {
  status: 'ready' | 'error';
  toolCount: number;
  calls: number;
  errors: number;
  lastLatencyMs: number | null;
  lastCallAt: string | null;
  error?: string;
}

interface BridgeHealth {
  schemaVersion: 1;
  provider: 'pi';
  status: 'ready' | 'degraded' | 'error';
  updatedAt: string;
  catalogTools: number;
  activeTools: number;
  servers: Record<string, ServerHealth>;
}

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

export function mcpToolName(serverName: string, toolName: string): string {
  if (!SAFE_NAME.test(serverName)) throw new Error(`Invalid MCP server name: ${serverName}`);
  if (!SAFE_NAME.test(toolName)) throw new Error(`Invalid MCP tool name: ${toolName}`);
  return `mcp__${serverName}__${toolName}`;
}

export function normalizeToolSchema(value: unknown): JsonSchema {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchema) : {};
  const { $schema: _ignored, ...copy } = input;
  return { type: 'object', ...copy };
}

export function searchMcpCatalog(query: string, catalog: McpCatalogEntry[], limit = 8): McpCatalogEntry[] {
  const terms = query.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
  return catalog
    .map((entry, index) => {
      const name = `${entry.serverName} ${entry.toolName} ${entry.piName}`.toLowerCase();
      const haystack = `${name} ${entry.description}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (name.includes(term) ? 4 : haystack.includes(term) ? 1 : 0), 0);
      return { entry, index, score };
    })
    .filter((candidate) => terms.length === 0 || candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index || a.entry.piName.localeCompare(b.entry.piName))
    .slice(0, Math.max(0, limit))
    .map(({ entry }) => entry);
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/((?:authorization|api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|xai|or)-[A-Za-z0-9._-]{8,}\b/g, '[redacted]')
    .slice(0, 500);
}

function toolText(content: unknown[] | undefined): string {
  if (!content?.length) return '(MCP tool returned no content)';
  return content
    .map((item) => {
      if (item && typeof item === 'object' && (item as any).type === 'text') return String((item as any).text ?? '');
      return JSON.stringify(item);
    })
    .join('\n');
}

async function defaultConnect(name: string, config: McpServerConfig): Promise<McpBridgeConnection> {
  const client = new Client({ name: `nanoclaw-pi-${name}`, version: '1.0.0' }, { capabilities: {} });
  const transport =
    config.type === 'http'
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        })
      : new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
          cwd: config.cwd,
          stderr: 'pipe',
        });
  await client.connect(transport);
  const listed = await client.listTools();
  return {
    tools: listed.tools,
    callTool: (toolName, args, options) => client.callTool({ name: toolName, arguments: args }, undefined, options),
    close: () => client.close(),
  };
}

export class McpBridge {
  private readonly servers: Record<string, McpServerConfig>;
  private readonly healthFile: string;
  private readonly eventsFile?: string;
  private readonly requiredServers: Set<string>;
  private readonly connect: (name: string, config: McpServerConfig) => Promise<McpBridgeConnection>;
  private readonly connections = new Map<string, McpBridgeConnection>();
  private startPromise?: Promise<void>;
  private health: BridgeHealth;

  constructor(options: {
    servers: Record<string, McpServerConfig>;
    healthFile: string;
    eventsFile?: string;
    requiredServers?: string[];
    connect?: (name: string, config: McpServerConfig) => Promise<McpBridgeConnection>;
  }) {
    this.servers = options.servers;
    this.healthFile = options.healthFile;
    this.eventsFile = options.eventsFile;
    this.requiredServers = new Set(options.requiredServers ?? (options.servers.nanoclaw ? ['nanoclaw'] : []));
    this.connect = options.connect ?? defaultConnect;
    this.health = {
      schemaVersion: 1,
      provider: 'pi',
      status: 'ready',
      updatedAt: new Date().toISOString(),
      catalogTools: 0,
      activeTools: 0,
      servers: {},
    };
  }

  start(pi: PiExtensionApi): Promise<void> {
    this.startPromise ??= this.startOnce(pi);
    return this.startPromise;
  }

  private async startOnce(pi: PiExtensionApi): Promise<void> {
    const baseActive = pi.getActiveTools();
    const catalog: McpCatalogEntry[] = [];
    const eager: string[] = [];
    for (const [serverName, config] of Object.entries(this.servers)) {
      try {
        const connection = await this.connect(serverName, config);
        this.connections.set(serverName, connection);
        this.health.servers[serverName] = {
          status: 'ready', toolCount: connection.tools.length, calls: 0, errors: 0, lastLatencyMs: null, lastCallAt: null,
        };
        for (const tool of connection.tools) {
          const piName = mcpToolName(serverName, tool.name);
          const entry = { piName, serverName, toolName: tool.name, description: tool.description ?? '' };
          catalog.push(entry);
          if (serverName === 'nanoclaw') eager.push(piName);
          pi.registerTool({
            name: piName,
            label: `${serverName}: ${tool.name}`,
            description: tool.description ?? `Call ${tool.name} on MCP server ${serverName}`,
            parameters: normalizeToolSchema(tool.inputSchema),
            execute: async (_callId, params, signal) => this.execute(entry, params, signal),
          });
        }
        this.record('mcp_server_ready', { server: serverName, toolCount: connection.tools.length });
      } catch (error) {
        const message = safeError(this.redactConfiguredSecrets(error instanceof Error ? error.message : String(error)));
        this.health.servers[serverName] = {
          status: 'error', toolCount: 0, calls: 0, errors: 1, lastLatencyMs: null, lastCallAt: null, error: message,
        };
        this.health.status = this.requiredServers.has(serverName) ? 'error' : 'degraded';
        this.record('mcp_server_error', { server: serverName, required: this.requiredServers.has(serverName), error: message });
        this.writeHealth();
        if (this.requiredServers.has(serverName)) {
          await this.close();
          throw new Error(`Required MCP server failed: ${serverName}: ${message}`);
        }
      }
    }

    if (catalog.some((entry) => entry.serverName !== 'nanoclaw')) {
      pi.registerTool({
        name: 'ToolSearch',
        label: 'MCP Tool Search',
        description: 'Find and activate deferred MCP tools by capability, server, or tool name.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Capability or MCP tool to find' } },
          required: ['query'],
        },
        execute: async (_callId, params) => {
          const matches = searchMcpCatalog(String(params.query ?? ''), catalog.filter((entry) => entry.serverName !== 'nanoclaw'));
          const active = new Set(pi.getActiveTools());
          for (const match of matches) active.add(match.piName);
          pi.setActiveTools([...active]);
          pi.appendEntry('nanoclaw-pi-mcp-active-tools', { tools: matches.map((match) => match.piName) });
          this.health.activeTools = [...active].filter((name) => name.startsWith('mcp__')).length;
          this.writeHealth();
          return {
            content: [{ type: 'text', text: matches.length ? matches.map((m) => `${m.piName} — ${m.description}`).join('\n') : 'No matching MCP tools.' }],
            details: { matches: matches.map((match) => match.piName) },
          };
        },
      });
    }

    const toolSearch = catalog.some((entry) => entry.serverName !== 'nanoclaw') ? ['ToolSearch'] : [];
    pi.setActiveTools([...new Set([...baseActive, ...toolSearch, ...eager])]);
    this.health.catalogTools = catalog.length;
    this.health.activeTools = eager.length;
    if (this.health.status !== 'degraded') this.health.status = 'ready';
    this.writeHealth();
    pi.on('session_shutdown', () => this.close());
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((connection) => connection.close()));
    this.connections.clear();
  }

  private async execute(entry: McpCatalogEntry, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const connection = this.connections.get(entry.serverName);
    if (!connection) throw new Error(`MCP server unavailable: ${entry.serverName}`);
    const started = Date.now();
    const server = this.health.servers[entry.serverName];
    server.calls += 1;
    server.lastCallAt = new Date().toISOString();
    this.record('mcp_call_start', { server: entry.serverName, tool: entry.toolName });
    try {
      // Deliberately exactly once: a disconnect after dispatch has an unknown
      // outcome and replaying a mutation could duplicate an external action.
      const result = await connection.callTool(entry.toolName, params, { signal });
      server.lastLatencyMs = Date.now() - started;
      this.record('mcp_call_end', { server: entry.serverName, tool: entry.toolName, latencyMs: server.lastLatencyMs, ok: !result.isError });
      this.writeHealth();
      if (result.isError) throw new Error(toolText(result.content));
      return { content: result.content?.length ? result.content : [{ type: 'text', text: '(MCP tool returned no content)' }], details: {} };
    } catch (error) {
      server.errors += 1;
      server.lastLatencyMs = Date.now() - started;
      server.error = safeError(this.redactConfiguredSecrets(error instanceof Error ? error.message : String(error)));
      this.health.status = this.requiredServers.has(entry.serverName) ? 'error' : 'degraded';
      this.record('mcp_call_error', { server: entry.serverName, tool: entry.toolName, latencyMs: server.lastLatencyMs, error: server.error });
      this.writeHealth();
      throw error;
    }
  }

  private redactConfiguredSecrets(message: string): string {
    let redacted = message;
    for (const config of Object.values(this.servers)) {
      const values = config.type === 'http' ? Object.values(config.headers ?? {}) : Object.values(config.env ?? {});
      for (const value of values) {
        if (value) redacted = redacted.split(value).join('[redacted]');
      }
    }
    return redacted;
  }

  private writeHealth(): void {
    this.health.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.healthFile), { recursive: true });
    const temp = `${this.healthFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.health, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.healthFile);
  }

  private record(type: string, fields: Record<string, unknown>): void {
    if (!this.eventsFile) return;
    fs.mkdirSync(path.dirname(this.eventsFile), { recursive: true });
    fs.appendFileSync(this.eventsFile, `${JSON.stringify({ ts: new Date().toISOString(), provider: 'pi', type, ...fields })}\n`, { mode: 0o600 });
  }
}
