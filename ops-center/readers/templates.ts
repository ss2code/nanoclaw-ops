/**
 * Read-only template provenance for the Ops Center.
 *
 * The group stores only a small `.nanoclaw-template.json` reference. The live
 * template source is parsed here so the dashboard can explain what is actually
 * mounted into a container, rather than inferring it from the stamped group
 * files (which are intentionally only a recovery copy).
 */
import fs from 'fs';
import path from 'path';

import { resolveTemplateForGroup } from '../../src/template-runtime.js';
import { parseTemplate, type TemplateOpsCenterContribution } from '../../src/templates/parse.js';

export type TemplateResolver = (groupDir: string) => string | null;

export interface TemplateFileInfo {
  name: string;
  bytes: number;
}

export interface TemplateSkillInfo {
  name: string;
  path: string;
}

export interface TemplateRuntimeMountInfo {
  source: string;
  target: string;
  readonly: boolean;
}

export interface GroupTemplateInfo {
  status: 'none' | 'ready' | 'error';
  ref: string | null;
  mode: 'live' | null;
  root: string | null;
  rootLabel: string | null;
  referenceFile: string;
  readme: boolean;
  instructions: { bytes: number; lines: number } | null;
  contextExtras: TemplateFileInfo[];
  skills: TemplateSkillInfo[];
  mcpServers: string[];
  runtimeMounts: TemplateRuntimeMountInfo[];
  opsCenter: TemplateOpsCenterContribution | null;
  error?: string;
}

const emptyInfo = (referenceFile: string): GroupTemplateInfo => ({
  status: 'none',
  ref: null,
  mode: null,
  root: null,
  rootLabel: null,
  referenceFile,
  readme: false,
  instructions: null,
  contextExtras: [],
  skills: [],
  mcpServers: [],
  runtimeMounts: [],
  opsCenter: null,
});

function errorInfo(base: GroupTemplateInfo, error: unknown): GroupTemplateInfo {
  return {
    ...base,
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  };
}

function lineCount(text: string): number {
  return text ? text.split(/\r?\n/).length : 0;
}

/** Read one group's template reference and the composition of its live source. */
export function readGroupTemplate(
  groupDir: string,
  resolve: TemplateResolver = resolveTemplateForGroup,
): GroupTemplateInfo {
  const referenceFile = path.join(groupDir, '.nanoclaw-template.json');
  const relativeReferenceFile = path.relative(process.cwd(), referenceFile);
  const base = emptyInfo(relativeReferenceFile);
  if (!fs.existsSync(referenceFile)) return base;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));
  } catch (error) {
    return errorInfo(base, `Invalid template reference: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return errorInfo(base, 'Invalid template reference object');
  const reference = raw as { schema?: unknown; ref?: unknown; mode?: unknown };
  const info: GroupTemplateInfo = {
    ...base,
    ref: typeof reference.ref === 'string' ? reference.ref : null,
    mode: reference.mode === 'live' ? 'live' : null,
  };
  if (
    (reference.schema !== 1 && reference.schema !== 2) ||
    typeof reference.ref !== 'string' ||
    reference.mode !== 'live'
  ) {
    return errorInfo(info, 'Unsupported template reference (expected schema 1 or 2 / live mode)');
  }

  let root: string | null;
  try {
    root = resolve(groupDir);
  } catch (error) {
    return errorInfo(info, error);
  }
  if (!root) return errorInfo(info, `Template source not found for ref "${reference.ref}"`);

  try {
    const parsed = parseTemplate(root);
    const instructions = parsed.instructions ?? '';
    return {
      ...info,
      status: 'ready',
      root,
      rootLabel: path.relative(process.cwd(), root) || '.',
      readme: fs.existsSync(path.join(root, 'README.md')),
      instructions: { bytes: Buffer.byteLength(instructions), lines: lineCount(instructions) },
      contextExtras: parsed.contextExtras.map((file) => ({ name: file.name, bytes: Buffer.byteLength(file.content) })),
      skills: parsed.skills.map((skill) => ({ name: skill.name, path: path.relative(root, skill.srcDir) })),
      mcpServers: Object.keys(parsed.mcpServers),
      runtimeMounts: parsed.runtimeMounts.map((mount) => ({
        source: mount.source,
        target: mount.target,
        readonly: mount.readonly !== false,
      })),
      opsCenter: parsed.opsCenter,
    };
  } catch (error) {
    return errorInfo({ ...info, root, rootLabel: path.relative(process.cwd(), root) || '.' }, error);
  }
}
