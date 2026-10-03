/** Agent Plugins skills/ discovery and frontmatter validation. */
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

export interface PluginSkill {
  name: string;
  srcDir: string;
}

export function readPluginSkills(pluginDir: string): { skills: PluginSkill[]; report: string[] } {
  const skillsDir = path.join(pluginDir, 'skills');
  const report: string[] = [];
  if (!fs.existsSync(skillsDir)) return { skills: [], report };
  if (!fs.lstatSync(skillsDir).isDirectory()) {
    return { skills: [], report: ['skills: not a directory; skills component skipped'] };
  }

  const skills: PluginSkill[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      report.push(`skills/${entry.name}: skipped: symlinks are not allowed in plugins`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const problem = validateSkill(path.join(skillsDir, entry.name));
    if (problem) report.push(`skills/${entry.name}: skipped: ${problem}`);
    else skills.push({ name: entry.name, srcDir: path.join(skillsDir, entry.name) });
  }
  return { skills, report };
}

function validateSkill(skillDir: string): string | undefined {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return 'no SKILL.md';
  const stat = fs.lstatSync(skillMd);
  if (stat.isSymbolicLink() || !stat.isFile()) return 'SKILL.md is not a regular file';

  const lines = fs.readFileSync(skillMd, 'utf-8').split(/\r?\n/);
  if (lines[0] !== '---') return 'SKILL.md is missing YAML frontmatter';
  const closing = lines.indexOf('---', 1);
  if (closing === -1) return 'SKILL.md frontmatter is missing the closing ---';
  let metadata: unknown;
  try {
    metadata = parse(lines.slice(1, closing).join('\n'));
  } catch {
    return 'SKILL.md frontmatter is not valid YAML';
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 'SKILL.md frontmatter must be a YAML mapping';
  }
  for (const field of ['name', 'description']) {
    const value = Reflect.get(metadata, field);
    if (typeof value !== 'string' || !value.trim()) return `SKILL.md frontmatter is missing "${field}"`;
  }
  return undefined;
}
