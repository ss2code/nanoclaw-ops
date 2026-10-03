import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { createAgentGroup } from '../db/agent-groups.js';
import { assertValidGroupFolder, resolveGroupFolderPath } from '../group-folder.js';
import { log } from '../log.js';
import { normalizeName } from '../modules/agent-to-agent/db/agent-destinations.js';
import type { AgentGroup } from '../types.js';
import { attachAgentGroupFromTemplate } from './attach-agent.js';
import { resolveLocalTemplate } from './local-dir.js';
import { markPluginServers } from './mcp.js';
import { parseTemplate } from './parse.js';

export interface CreateAgentOptions {
  name?: string;
}

// Kept as a compatibility export for callers that used the Phase 1 helper.
export { markPluginServers };

/**
 * Create a new agent group and attach a local template to it. The attachment
 * engine is shared with existing-group restamping, so both paths get the same
 * ownership manifest, version provenance, conflict checks, and stable task IDs.
 */
export function createAgentFromTemplate(ref: string, opts?: CreateAgentOptions): AgentGroup {
  const dir = resolveLocalTemplate(ref);
  const tpl = parseTemplate(dir);

  const id = randomUUID();
  const name = opts?.name ?? tpl.agentName ?? path.basename(dir);
  let folder = normalizeName(name);
  assertValidGroupFolder(folder);
  if (fs.existsSync(resolveGroupFolderPath(folder))) folder = `${folder}-${randomUUID().slice(0, 8)}`;

  const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: new Date().toISOString() };
  createAgentGroup(group);
  attachAgentGroupFromTemplate(id, ref);

  for (const line of tpl.report) log.warn('Template reader notice', { ref, notice: line });
  return group;
}
