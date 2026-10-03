/** Host-side state, context, skill, and auth contribution for Pi. */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { materializeTemplateSkills } from '../group-skills.js';
import { templateSkillNames } from '../template-runtime.js';
import { composeGroupAgentsMd } from './codex-agents-md.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig(
  'pi',
  (ctx) => {
    const piDir = path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, '.pi-shared');
    const skillsDir = path.join(piDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });

    const group = getAgentGroup(ctx.agentGroupId);
    if (group) composeGroupAgentsMd(group, ctx.groupDir);
    syncPiSkillLinks(ctx.groupDir, skillsDir, ctx.selectedSkills);
    materializeTemplateSkills(ctx.agentGroupId, skillsDir);

    const env: Record<string, string> = {};
    const upstream = ctx.configuredModel?.split('/', 1)[0]?.toLowerCase();
    // Pi's native xAI OAuth state belongs in ~/.pi/agent/auth.json. OpenRouter
    // remains key-based, but the value is a sentinel: OneCLI replaces it only
    // on matching outbound requests, so no usable credential enters the
    // container environment or filesystem.
    if (upstream === 'openrouter') env.OPENROUTER_API_KEY = 'onecli-managed';

    const mounts = [{ hostPath: piDir, containerPath: '/home/node/.pi/agent', readonly: false }];
    const agentsMd = path.join(ctx.groupDir, 'AGENTS.md');
    if (fs.existsSync(agentsMd)) {
      mounts.push({ hostPath: agentsMd, containerPath: '/workspace/agent/AGENTS.md', readonly: true });
    }
    return { mounts, env };
  },
  { providesAgentSurfaces: true },
);

function syncPiSkillLinks(groupDir: string, skillsDir: string, selectedSkills: string[]): void {
  const templateNames = new Set(templateSkillNames(groupDir));
  const desired = new Set(selectedSkills.filter((name) => !templateNames.has(name)));
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    try {
      if (fs.lstatSync(entryPath).isSymbolicLink() && !desired.has(entry)) fs.unlinkSync(entryPath);
    } catch {
      // A concurrent group initialization may have removed it already.
    }
  }
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    try {
      fs.lstatSync(linkPath);
    } catch {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}
