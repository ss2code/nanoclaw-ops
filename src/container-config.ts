/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/** Container-side path where stamped Agent Plugin directories are mounted. */
export const CONTAINER_PLUGINS_DIR = '/workspace/agent/plugins';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  pluginRoot?: string;
  plugin?: string;
  instructions?: string;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  plugin?: string;
  instructions?: string;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CWD_FORM_RE = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

export function validateMcpServerName(name: string): void {
  if (!MCP_SERVER_NAME_RE.test(name) || name === '__proto__') {
    throw new Error('server name must be 1-64 characters of letters, digits, "_" or "-"');
  }
}

/** Parse legacy CLI input and Agent Plugins stdio/HTTP definitions. */
export function parseMcpServerConfig(input: Record<string, unknown>): McpServerConfig {
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;
  const type = input.type === 'streamable-http' ? 'http' : input.type;
  if (type === 'sse') throw new Error('unsupported transport "sse"');
  if (type !== undefined && type !== 'stdio' && type !== 'http')
    throw new Error('type must be "stdio", "http", or "streamable-http"');
  if (type === 'stdio' && !command) throw new Error('type "stdio" requires command');
  if (type === 'http' && !url) throw new Error('type "http" requires url');

  const instructions = input.instructions;
  if (instructions !== undefined && typeof instructions !== 'string')
    throw new Error('MCP instructions must be a string');

  if (url !== undefined) {
    if (command !== undefined) throw new Error('Provide exactly one of command or url');
    if (input.args !== undefined || input.env !== undefined || input.cwd !== undefined) {
      throw new Error('args, env, and cwd are only valid with command');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new Error('url must be a valid HTTP(S) URL', { cause: err });
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('url must use HTTPS (plain HTTP is allowed only for localhost)');
    }
    if (parsed.username || parsed.password || parsed.hash)
      throw new Error('url must not contain credentials or fragments');
    const headers = parseStringRecord(input.headers, 'headers');
    return {
      type: 'http',
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(instructions === undefined ? {} : { instructions }),
    };
  }
  if (command === undefined) throw new Error('Provide exactly one of command or url');
  if (input.headers !== undefined) throw new Error('headers is only valid with url');
  const args = input.args ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))
    throw new Error('args must be a JSON array of strings');
  const env = parseStringRecord(input.env, 'env') ?? {};
  for (const key of Object.keys(env))
    if (!ENV_KEY_RE.test(key))
      throw new Error(`env key ${JSON.stringify(key)} must be a valid environment variable name`);
  const cwd = input.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || !CWD_FORM_RE.test(cwd))) {
    throw new Error('cwd must be ./path, ${PLUGIN_ROOT}[/path], or ${PLUGIN_DATA}[/path]');
  }
  if (typeof cwd === 'string') {
    const rest = cwd.startsWith('./') ? cwd.slice(2) : cwd.replace(CWD_FORM_RE, '');
    if (
      rest.includes('${') ||
      rest.includes('\\') ||
      (rest !== '' && rest.split('/').some((segment) => segment === '..' || segment === ''))
    ) {
      throw new Error('cwd escapes the plugin root');
    }
  }
  return {
    command,
    args,
    env,
    ...(cwd === undefined ? {} : { cwd }),
    ...(instructions === undefined ? {} : { instructions }),
  };
}

function parseStringRecord(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} must be a JSON object with string values`);
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`${name} must be a JSON object with string values`);
    record[key] = entry;
  }
  return record;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Resource/syscall caps applied to a hardened group's container. */
export interface HardeningCaps {
  /** --pids-limit (fork-bomb containment). */
  pidsLimit?: number;
  /** --memory, e.g. "2g". Overrides the global CONTAINER_MEMORY_LIMIT. */
  memory?: string;
  /** --cpus, e.g. "2". Overrides the global CONTAINER_CPU_LIMIT. */
  cpus?: string;
  /** --tmpfs /tmp:size=<value>, e.g. "512m". */
  tmpfs?: string;
  /** --security-opt no-new-privileges. */
  noNewPrivileges?: boolean;
  /** --cap-drop ALL. */
  capDrop?: boolean;
}

/** Per-group access level for the shared document hub mount. */
export type HubAccess = 'read-write' | 'read-only' | 'none';

/** One of the three model-routing tiers. */
export type ModelTier = 'high' | 'medium' | 'low';

/**
 * Per-group high/medium/low model routing (OpenCode/OpenRouter groups).
 * Each tier is a catalog model id; `default` names the tier that supplies the
 * group's default (main-session) model. Absent = no tiers.
 */
export interface ModelTiers {
  high: string;
  medium: string;
  low: string;
  default: ModelTier;
}

/**
 * Per-group isolation hardening profile. Absent/undefined = hardening off
 * (today's behavior, all existing groups). One coherent opt-in block —
 * see docs/local/handoffs/isolation-hardening-handover.md (private overlay).
 */
export interface HardeningConfig {
  /**
   * Place the container on a per-group internal network whose only hop is
   * the egress filter proxy (which relays allowlisted hosts to the OneCLI
   * gateway). Fail-closed: spawn is refused if the topology can't be built.
   */
  egress?: boolean;
  /**
   * Hosts the filter proxy will relay (exact match or "*.domain" wildcard,
   * port 443 only). Everything else is refused at the filter.
   */
  allowHosts?: string[];
  caps?: HardeningCaps;
  /** Enable the agent-runner scrub layer (output scrubbing + untrusted-content wrapping). */
  scrub?: boolean;
  /**
   * Access to the shared document hub. Default remains read-write for backward
   * compatibility; untrusted workers can read context without publishing.
   */
  hubAccess?: HubAccess;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  platformAliases?: string[];
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  hardening?: HardeningConfig;
  modelTiers?: ModelTiers;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  const modelTiers = row.model_tiers ? (JSON.parse(row.model_tiers) as ModelTiers) : undefined;
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    platformAliases: [ASSISTANT_NAME],
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: modelTiers ? modelTiers[modelTiers.default] : (row.model ?? undefined),
    effort: row.effort ?? undefined,
    hardening: row.hardening ? (JSON.parse(row.hardening) as HardeningConfig) : undefined,
    modelTiers,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
