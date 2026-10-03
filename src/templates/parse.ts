import fs from 'fs';
import path from 'path';

import type { McpServerConfig } from '../container-config.js';
import { readNanoclawExtension } from './extension.js';
import { parsePluginManifest, PLUGIN_MANIFEST_FILE } from './manifest.js';
import { readPluginMcp } from './mcp.js';
import { walkPluginDir } from './plugin-dir.js';
import { readPluginSkills } from './skills.js';
import type { TemplateTask } from './tasks.js';

export type { TemplateTask } from './tasks.js';

/** Parsed legacy or Agent Plugins 1.0.0 template data. */
export interface Template {
  /** Agent Plugin manifest name, or the legacy directory leaf. */
  name: string;
  /** Agent Plugin manifest version. Legacy templates are unversioned. */
  version?: string;
  agentName?: string;
  mcpServers: Record<string, McpServerConfig>;
  instructions?: string;
  contextExtras: { name: string; content: string }[];
  skills: { name: string; srcDir: string }[];
  tasks: TemplateTask[];
  runtimeMounts: { source: string; target: string; readonly?: boolean }[];
  opsCenter: TemplateOpsCenterContribution | null;
  dir: string;
  layout: 'legacy' | 'agent-plugin';
  /** Relative extension/context root used by the live template runtime. */
  contextRoot: string;
  report: string[];
}

export interface TemplateOpsCenterContribution {
  schema: 1;
  id: string;
  label: string;
  icon: string;
  entry: string;
  assets: string;
  assetNames: string[];
}

function readJson(file: string): unknown {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read either the current plugin layout or the pre-Agent-Plugins layout. */
export function parseTemplate(dir: string): Template {
  if (!fs.existsSync(dir)) throw new Error(`Template folder not found: ${dir}`);
  const manifest = path.join(dir, PLUGIN_MANIFEST_FILE);
  if (fs.existsSync(manifest)) return parseAgentPlugin(dir);
  if (fs.existsSync(path.join(dir, 'context', 'instructions.md'))) return parseLegacyTemplate(dir);
  throw new Error(
    `Not an agent plugin: ${PLUGIN_MANIFEST_FILE} not found in ${dir}; legacy templates require context/instructions.md`,
  );
}

function parseAgentPlugin(dir: string): Template {
  walkPluginDir(dir);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, PLUGIN_MANIFEST_FILE), 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${PLUGIN_MANIFEST_FILE} is not valid JSON: ${message}`, { cause: err });
  }
  const parsed = parsePluginManifest(raw);
  const { skills, report: skillReport } = readPluginSkills(dir);
  const { servers, report: mcpReport } = readPluginMcp(dir);
  const extension = readNanoclawExtension(dir, parsed.extensions);
  return {
    name: parsed.name,
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(extension.agentName === undefined ? {} : { agentName: extension.agentName }),
    mcpServers: servers,
    ...(extension.instructions === undefined ? {} : { instructions: extension.instructions }),
    contextExtras: extension.contextExtras,
    skills,
    tasks: extension.tasks,
    runtimeMounts: [],
    opsCenter: null,
    dir: path.resolve(dir),
    layout: 'agent-plugin',
    contextRoot: 'ai.nanoco.nanoclaw/context',
    report: [...parsed.report, ...skillReport, ...mcpReport, ...extension.report],
  };
}

function parseLegacyTemplate(dir: string): Template {
  const instructionsFile = path.join(dir, 'context', 'instructions.md');
  const instructions = fs.readFileSync(instructionsFile, 'utf-8').trimEnd();
  return {
    name: path.basename(dir),
    mcpServers: asRecord(asRecord(readJson(path.join(dir, '.mcp.json'))).mcpServers) as Record<string, McpServerConfig>,
    instructions,
    contextExtras: readContextExtras(path.join(dir, 'context')),
    skills: readLegacySkills(path.join(dir, 'skills')),
    tasks: [],
    runtimeMounts: readRuntimeMounts(dir),
    opsCenter: readOpsCenterContribution(dir),
    dir: path.resolve(dir),
    layout: 'legacy',
    contextRoot: 'context',
    report: [],
  };
}

function readOpsCenterContribution(dir: string): TemplateOpsCenterContribution | null {
  const file = path.join(dir, 'ops-center.json');
  if (!fs.existsSync(file)) return null;
  const record = asRecord(readJson(file));
  if (record.schema !== 1) throw new Error(`Unsupported Ops Center contribution schema: ${dir}`);
  const id = typeof record.id === 'string' ? record.id : '';
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  const icon = typeof record.icon === 'string' ? record.icon : '';
  const entry = typeof record.entry === 'string' ? record.entry : '';
  const assets = typeof record.assets === 'string' ? record.assets : '';
  const assetNames = Array.isArray(record.assetNames)
    ? record.assetNames.filter((name): name is string => typeof name === 'string')
    : [];
  if (!Array.isArray(record.assetNames) || assetNames.length !== record.assetNames.length)
    throw new Error(`Ops Center contribution assetNames must be an array of strings: ${dir}`);
  if (!/^[a-z][a-z0-9-]{1,49}$/.test(id)) throw new Error(`Ops Center contribution has an invalid id: ${dir}`);
  if (!label || label.length > 80) throw new Error(`Ops Center contribution has an invalid label: ${dir}`);
  if (!icon || [...icon].length > 4) throw new Error(`Ops Center contribution has an invalid icon: ${dir}`);
  for (const [name, value] of [
    ['entry', entry],
    ['assets', assets],
  ] as const) {
    if (!value || path.isAbsolute(value) || value.startsWith('~'))
      throw new Error(`Ops Center contribution ${name} must be a relative path: ${dir}`);
    const resolved = path.resolve(dir, value);
    const relative = path.relative(dir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`Ops Center contribution ${name} escapes the template: ${dir}`);
  }
  if (!assetNames.length || assetNames.some((name) => !/^[a-zA-Z0-9._-]+$/.test(name)))
    throw new Error(`Ops Center contribution assetNames must contain safe file names: ${dir}`);
  if (!fs.existsSync(path.join(dir, entry)))
    throw new Error(`Ops Center contribution entry is missing: ${path.join(dir, entry)}`);
  if (!fs.statSync(path.join(dir, assets)).isDirectory())
    throw new Error(`Ops Center contribution assets is not a directory: ${path.join(dir, assets)}`);
  for (const name of assetNames)
    if (!fs.existsSync(path.join(dir, assets, name)))
      throw new Error(`Ops Center contribution asset is missing: ${path.join(dir, assets, name)}`);
  return { schema: 1, id, label, icon, entry, assets, assetNames };
}

function readRuntimeMounts(dir: string): { source: string; target: string; readonly?: boolean }[] {
  const raw = readJson(path.join(dir, 'runtime.json'));
  const record = asRecord(raw);
  if (raw === undefined) return [];
  if (!Array.isArray(record.mounts)) throw new Error(`Template runtime.json mounts must be an array: ${dir}`);
  return record.mounts.map((entry, index) => {
    const mount = asRecord(entry);
    const source = typeof mount.source === 'string' ? mount.source : '';
    const target = typeof mount.target === 'string' ? mount.target : '';
    if (!source || path.isAbsolute(source) || source.startsWith('~'))
      throw new Error(`Template runtime mount ${index} has an invalid relative source: ${dir}`);
    const resolvedSource = path.resolve(dir, source);
    const relativeSource = path.relative(dir, resolvedSource);
    if (relativeSource.startsWith('..') || path.isAbsolute(relativeSource))
      throw new Error(`Template runtime mount ${index} escapes the template: ${dir}`);
    if (!target.startsWith('/workspace/agent/') || target.includes('..'))
      throw new Error(`Template runtime mount ${index} must target /workspace/agent/: ${target}`);
    return { source, target, readonly: mount.readonly !== false };
  });
}

function readContextExtras(contextDir: string): { name: string; content: string }[] {
  if (!fs.existsSync(contextDir)) return [];
  return (fs.readdirSync(contextDir, { recursive: true }) as string[])
    .map((entry) => entry.split(path.sep).join('/'))
    .filter(
      (entry) =>
        entry.endsWith('.md') && entry !== 'instructions.md' && fs.statSync(path.join(contextDir, entry)).isFile(),
    )
    .map((name) => ({ name, content: fs.readFileSync(path.join(contextDir, name), 'utf-8') }));
}

function readLegacySkills(skillsDir: string): { name: string; srcDir: string }[] {
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir)
    .map((name) => ({ name, srcDir: path.join(skillsDir, name) }))
    .filter(({ srcDir }) => fs.statSync(srcDir).isDirectory());
}
