/** NanoClaw's optional Agent Plugins extension namespace. */
import fs from 'fs';
import path from 'path';

import { readTasks, type TemplateTask } from './tasks.js';

export const NANOCLAW_EXTENSION_NS = 'ai.nanoco.nanoclaw';

export interface NanoclawExtension {
  agentName?: string;
  instructions?: string;
  contextExtras: { name: string; content: string }[];
  tasks: TemplateTask[];
  report: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readNanoclawExtension(
  pluginDir: string,
  manifestExtensions: Record<string, unknown>,
): NanoclawExtension {
  const report: string[] = [];
  let agentName: string | undefined;
  const ours = manifestExtensions[NANOCLAW_EXTENSION_NS];
  if (ours !== undefined) {
    if (!isPlainObject(ours)) {
      report.push(`plugin.json: extensions["${NANOCLAW_EXTENSION_NS}"] is not an object; ignored`);
    } else {
      const value = ours.agentName;
      if (value !== undefined) {
        if (typeof value === 'string' && value.trim()) agentName = value.trim();
        else
          report.push(
            `plugin.json: extensions["${NANOCLAW_EXTENSION_NS}"].agentName must be a nonempty string; ignored`,
          );
      }
      for (const key of Object.keys(ours)) {
        if (key !== 'agentName')
          report.push(`plugin.json: extensions["${NANOCLAW_EXTENSION_NS}"].${key} is not recognized; ignored`);
      }
    }
  }

  const extensionDir = path.join(pluginDir, NANOCLAW_EXTENSION_NS);
  const contextDir = path.join(extensionDir, 'context');
  const instructionsFile = path.join(contextDir, 'instructions.md');
  let instructions: string | undefined;
  if (fs.existsSync(instructionsFile)) {
    if (!fs.lstatSync(instructionsFile).isFile()) {
      throw new Error(`${NANOCLAW_EXTENSION_NS}/context/instructions.md must be a regular file`);
    }
    instructions = fs.readFileSync(instructionsFile, 'utf-8').trimEnd();
  }

  const contextExtras = fs.existsSync(contextDir)
    ? (fs.readdirSync(contextDir, { recursive: true }) as string[])
        .map((entry) => entry.split(path.sep).join('/'))
        .filter((entry) => entry.endsWith('.md') && entry !== 'instructions.md')
        .filter((entry) => fs.lstatSync(path.join(contextDir, entry)).isFile())
        .sort()
        .map((name) => ({ name, content: fs.readFileSync(path.join(contextDir, name), 'utf-8') }))
    : [];

  return {
    ...(agentName === undefined ? {} : { agentName }),
    ...(instructions === undefined ? {} : { instructions }),
    contextExtras,
    tasks: readTasks(path.join(extensionDir, 'tasks'), `${NANOCLAW_EXTENSION_NS}/tasks`),
    report,
  };
}
