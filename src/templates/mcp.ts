/** Agent Plugins 1.0.0 mcp.json reader. */
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_PLUGINS_DIR,
  parseMcpServerConfig,
  validateMcpServerName,
  type McpServerConfig,
} from '../container-config.js';
import { MCP_SCHEMA_URL } from './manifest.js';

export const PLACEHOLDER_VALUE = 'placeholder';
const HOST_GATEWAY_HOSTS = new Set(['host.docker.internal', 'gateway.docker.internal', '172.17.0.1']);
const SECRET_KEY_RE =
  /(^|[_.-])(api[_-]?key|token|secret|password|private[_-]?key|authorization|credential|bearer|jwt)([_.-]|$)/i;
const SECRET_VALUE_RE =
  /^(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-|AKIA[0-9A-Z]{12,}|-----BEGIN )/;
const SECRET_QUERY_KEY_RE =
  /(^|[_.-])(o?auth(orization)?|(auth|access|api|session|id)?[_-]?token|secret|passw(or)?d|pwd|api[_-]?key|private[_-]?key|credentials?|bearer|jwt|sig(nature)?)([_.-]|$)/i;
const CAMEL_SPLIT_RE = /([a-z0-9])([A-Z])/g;

/** Add runtime provenance/paths without copying or exposing credentials. */
export function markPluginServers(
  servers: Record<string, McpServerConfig>,
  pluginName: string,
): Record<string, McpServerConfig> {
  const pluginRoot = `${CONTAINER_PLUGINS_DIR}/${pluginName}`;
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.type === 'http'
        ? { ...server, plugin: pluginName }
        : { cwd: '${PLUGIN_ROOT}', ...server, plugin: pluginName, pluginRoot },
    ]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pluginDataCwdSubpaths(servers: Record<string, McpServerConfig>): string[] {
  const prefix = '${PLUGIN_DATA}/';
  return Object.values(servers).flatMap((server) =>
    server.type !== 'http' && server.cwd?.startsWith(prefix) ? [server.cwd.slice(prefix.length)] : [],
  );
}

export function readPluginMcp(pluginDir: string): { servers: Record<string, McpServerConfig>; report: string[] } {
  const report: string[] = [];
  const file = path.join(pluginDir, 'mcp.json');
  if (fs.existsSync(path.join(pluginDir, '.mcp.json')))
    report.push('.mcp.json: ignored (legacy name); rename it to mcp.json');
  if (!fs.existsSync(file)) return { servers: {}, report };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { servers: {}, report: ['mcp.json: not valid JSON; MCP component skipped'] };
  }
  if (!isPlainObject(raw)) return { servers: {}, report: ['mcp.json: not a JSON object; MCP component skipped'] };
  if (raw.$schema !== MCP_SCHEMA_URL)
    return { servers: {}, report: [`mcp.json: $schema must be "${MCP_SCHEMA_URL}"; MCP component skipped`] };
  const unknownTop = Object.keys(raw).filter((key) => key !== '$schema' && key !== 'mcpServers');
  if (unknownTop.length > 0)
    return {
      servers: {},
      report: [`mcp.json: allows exactly $schema and mcpServers (found "${unknownTop[0]}"); MCP component skipped`],
    };
  if (!isPlainObject(raw.mcpServers))
    return { servers: {}, report: ['mcp.json: mcpServers must be an object; MCP component skipped'] };

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    try {
      validateMcpServerName(name);
      if (!isPlainObject(entry)) throw new Error('not an object');
      const type = entry.type;
      if (type === 'sse') throw new Error('unsupported transport "sse"');
      if (type !== 'stdio' && type !== 'streamable-http') throw new Error('type must be "stdio" or "streamable-http"');
      const allowed =
        type === 'stdio' ? new Set(['type', 'command', 'args', 'env', 'cwd']) : new Set(['type', 'url', 'headers']);
      const unknown = Object.keys(entry).find((key) => !allowed.has(key));
      if (unknown) throw new Error(`unknown field "${unknown}"`);
      const server = parseMcpServerConfig({ ...entry, type: type === 'streamable-http' ? 'http' : type });
      if (server.type === 'http') {
        const hostname = new URL(server.url).hostname;
        if (HOST_GATEWAY_HOSTS.has(hostname))
          throw new Error(`URL host "${hostname}" reaches the container host; not allowed`);
        for (const key of new URL(server.url).searchParams.keys()) {
          if (SECRET_QUERY_KEY_RE.test(key.replace(CAMEL_SPLIT_RE, '$1_$2'))) {
            throw new Error(`URL query parameter "${key}" looks like a credential; use OneCLI for authentication`);
          }
        }
        lintSecrets(name, server.headers ?? {}, report);
      } else {
        if (/\s/.test(server.command)) throw new Error('command must be a single token (no shell strings)');
        if (server.command.includes('${'))
          throw new Error('command does not support ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion');
        if (server.command.startsWith('./')) {
          const parts = server.command.slice(2).split('/');
          if (parts.some((part) => part === '..' || part === '')) throw new Error('command escapes the plugin root');
        } else if (server.command.includes('/') || server.command.includes('\\')) {
          throw new Error('command must be a bare executable name or a ./-relative path');
        }
        for (const key of Object.keys(server.env ?? {})) {
          if (key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA') throw new Error(`env must not define "${key}"`);
        }
        lintSecrets(name, server.env ?? {}, report);
      }
      servers[name] = server;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/looks like a real credential/.test(message))
        throw new Error(`mcp.json server "${name}": ${message}`, { cause: err });
      report.push(`mcp.json: server "${name}" skipped: ${message}`);
    }
  }
  return { servers, report };
}

function lintSecrets(server: string, values: Record<string, string>, report: string[]): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === PLACEHOLDER_VALUE) continue;
    const bare = value.replace(/^(Bearer|Token|Basic)\s+/i, '');
    if (SECRET_VALUE_RE.test(bare))
      throw new Error(`value for ${server} "${key}" looks like a real credential; use "${PLACEHOLDER_VALUE}"`);
    if (SECRET_KEY_RE.test(key))
      report.push(`mcp.json: server "${server}" ${key} has a credential-shaped key; use the placeholder convention`);
  }
}
