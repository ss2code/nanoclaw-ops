/**
 * Live source surfaces for local templates.
 *
 * A template is stamped once, but its source remains the source of truth while
 * developing. The group keeps only a small reference file; the runner mounts
 * the template's instructions, context, skills, and declared runtime paths
 * read-only on every spawn. This is the same source-vs-image split used by
 * NanoClaw's own agent-runner source mount, generalized to templates.
 */
import fs from 'fs';
import path from 'path';

import { TEMPLATES_DIR } from './config.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import { parseTemplate } from './templates/parse.js';
import { resolveLocalTemplate } from './templates/local-dir.js';

export const TEMPLATE_REFERENCE_FILE = '.nanoclaw-template.json';

export interface TemplateProvenance {
  name: string;
  version: string | null;
  layout: 'legacy' | 'agent-plugin';
}

export interface TemplateManagedState {
  /** Group-relative regular files owned by the template. */
  files: Record<string, { sha256: string }>;
  /** Group-relative directories copied from the template. */
  trees: Record<string, { sha256: string }>;
  /** MCP names added by the template; values are hashes, never credentials. */
  mcpServers: Record<string, { sha256: string }>;
  /** Template task series; hashes exclude scheduler-mutated status/timestamps. */
  tasks: Record<string, { id: string; sessionId: string; sha256: string; source: string }>;
}

export interface TemplateReferenceV1 {
  schema: 1;
  ref: string;
  mode: 'live';
}

export interface TemplateReferenceV2 {
  schema: 2;
  ref: string;
  mode: 'live';
  provenance: TemplateProvenance;
  attachedAt: string;
  managed: TemplateManagedState;
}

export type TemplateReference = TemplateReferenceV1 | TemplateReferenceV2;

export const emptyTemplateManagedState = (): TemplateManagedState => ({
  files: {},
  trees: {},
  mcpServers: {},
  tasks: {},
});

function refForTemplate(templateDir: string): string {
  const relative = path.relative(TEMPLATES_DIR, path.resolve(templateDir));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Template must live inside ${TEMPLATES_DIR}`);
  }
  return relative.split(path.sep).join('/');
}

/** Read a template reference, returning null for ordinary non-template groups. */
export function readTemplateReference(groupDir: string): TemplateReference | null {
  const file = path.join(groupDir, TEMPLATE_REFERENCE_FILE);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Invalid ${TEMPLATE_REFERENCE_FILE} in ${groupDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`Invalid ${TEMPLATE_REFERENCE_FILE} in ${groupDir}`);
  const reference = raw as {
    schema?: unknown;
    mode?: unknown;
    ref?: unknown;
    provenance?: unknown;
    managed?: unknown;
  };
  if (reference.mode !== 'live' || typeof reference.ref !== 'string') {
    throw new Error(`Unsupported ${TEMPLATE_REFERENCE_FILE} in ${groupDir}`);
  }
  if (reference.schema === 1) return reference as TemplateReferenceV1;
  if (
    reference.schema !== 2 ||
    !reference.provenance ||
    typeof reference.provenance !== 'object' ||
    !reference.managed ||
    typeof reference.managed !== 'object'
  ) {
    throw new Error(`Unsupported ${TEMPLATE_REFERENCE_FILE} in ${groupDir}`);
  }
  return reference as TemplateReferenceV2;
}

/** Record a template reference without copying its runtime source. */
export function writeTemplateReference(
  groupDir: string,
  templateDir: string,
  provenance?: TemplateProvenance,
  managed: TemplateManagedState = emptyTemplateManagedState(),
): void {
  const reference: TemplateReferenceV2 = {
    schema: 2,
    ref: refForTemplate(templateDir),
    mode: 'live',
    provenance: provenance ?? { name: path.basename(templateDir), version: null, layout: 'legacy' },
    attachedAt: new Date().toISOString(),
    managed,
  };
  const file = path.join(groupDir, TEMPLATE_REFERENCE_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(reference, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Resolve a group's reference, returning null for ordinary non-template groups. */
export function resolveTemplateForGroup(groupDir: string): string | null {
  const reference = readTemplateReference(groupDir);
  if (!reference) return null;
  return resolveLocalTemplate(reference.ref);
}

function templateForGroup(groupDir: string): { root: string; parsed: ReturnType<typeof parseTemplate> } | null {
  const root = resolveTemplateForGroup(groupDir);
  return root ? { root, parsed: parseTemplate(root) } : null;
}

/** Resolve the live persona file for either template layout. */
export function templateInstructionsPath(groupDir: string): string | null {
  const template = templateForGroup(groupDir);
  if (!template || template.parsed.instructions === undefined) return null;
  const file = path.join(template.root, template.parsed.contextRoot, 'instructions.md');
  return fs.existsSync(file) ? file : null;
}

function ensureWorkspaceTarget(groupDir: string, target: string, sourceIsFile: boolean): void {
  const relative = target.slice('/workspace/agent/'.length);
  const hostTarget = path.join(groupDir, relative);
  const parent = path.dirname(hostTarget);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(hostTarget)) {
    const targetIsDirectory = fs.lstatSync(hostTarget).isDirectory();
    if (sourceIsFile && targetIsDirectory) {
      throw new Error(`Template runtime mount target is a directory but source is a file: ${target}`);
    }
    if (!sourceIsFile && !targetIsDirectory) {
      throw new Error(`Template runtime mount target is a file but source is a directory: ${target}`);
    }
  }
}

/** Declared app/runtime paths plus live instructions and context files. */
export function templateWorkspaceMounts(groupDir: string): VolumeMount[] {
  const template = templateForGroup(groupDir);
  if (!template) return [];

  const mounts: VolumeMount[] = [];
  for (const declared of template.parsed.runtimeMounts) {
    const source = path.join(template.root, declared.source);
    if (!fs.existsSync(source)) throw new Error(`Template runtime mount source is missing: ${source}`);
    if (declared.target.startsWith('/workspace/agent/'))
      ensureWorkspaceTarget(groupDir, declared.target, fs.statSync(source).isFile());
    mounts.push({ hostPath: source, containerPath: declared.target, readonly: declared.readonly !== false });
  }

  const instructions = path.join(template.root, template.parsed.contextRoot, 'instructions.md');
  if (fs.existsSync(instructions)) {
    ensureWorkspaceTarget(groupDir, '/workspace/agent/instructions.prepend.md', true);
    mounts.push({ hostPath: instructions, containerPath: '/workspace/agent/instructions.prepend.md', readonly: true });
  }

  for (const extra of template.parsed.contextExtras) {
    const source = path.join(template.root, template.parsed.contextRoot, extra.name);
    const target = `/workspace/agent/${extra.name.split(path.sep).join('/')}`;
    ensureWorkspaceTarget(groupDir, target, true);
    mounts.push({ hostPath: source, containerPath: target, readonly: true });
  }
  return mounts;
}

/** Mount the durable plugin copy read-only inside the agent workspace. */
export function templatePluginMount(groupDir: string): VolumeMount | null {
  const template = templateForGroup(groupDir);
  if (!template || template.parsed.layout !== 'agent-plugin') return null;
  const hostPath = path.join(groupDir, 'plugins', template.parsed.name);
  if (!fs.existsSync(hostPath)) return null;
  return {
    hostPath,
    containerPath: `/workspace/agent/plugins/${template.parsed.name}`,
    readonly: true,
  };
}

/** Template skills for a provider's native skill root (e.g. Claude or Codex). */
export function templateSkillMounts(groupDir: string, containerSkillsRoot: string): VolumeMount[] {
  const template = templateForGroup(groupDir);
  if (!template) return [];
  return template.parsed.skills.map((skill) => ({
    hostPath: skill.srcDir,
    containerPath: `${containerSkillsRoot.replace(/\/$/, '')}/${skill.name}`,
    readonly: true,
  }));
}

export function templateSkillNames(groupDir: string): string[] {
  return templateForGroup(groupDir)?.parsed.skills.map((skill) => skill.name) ?? [];
}

/** Source roots whose contents affect a live template group's runtime. */
export function templateRuntimeRoots(groupDir: string): string[] {
  const root = resolveTemplateForGroup(groupDir);
  return root ? [root] : [];
}
