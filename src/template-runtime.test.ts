import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { templateRuntimeRoots, templateSkillMounts, templateWorkspaceMounts } from './template-runtime.js';

const groupDirs: string[] = [];

afterEach(() => {
  for (const dir of groupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('template runtime surfaces', () => {
  it('mounts the checked-out tutor source and exposes its live skill roots', () => {
    const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-runtime-'));
    groupDirs.push(groupDir);
    fs.writeFileSync(
      path.join(groupDir, '.nanoclaw-template.json'),
      JSON.stringify({
        schema: 1,
        ref: 'education/knowledge-graph-tutor',
        mode: 'live',
      }),
    );

    const workspace = templateWorkspaceMounts(groupDir);
    const skills = templateSkillMounts(groupDir, '/home/node/.claude/skills');
    expect(workspace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ containerPath: '/workspace/agent/tutor-app/app', readonly: true }),
        expect.objectContaining({ containerPath: '/workspace/agent/instructions.prepend.md', readonly: true }),
      ]),
    );
    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ containerPath: '/home/node/.claude/skills/proactive-coaching', readonly: true }),
      ]),
    );
    expect(templateRuntimeRoots(groupDir)).toHaveLength(1);
  });
});
