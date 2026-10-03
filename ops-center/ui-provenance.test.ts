import { describe, expect, it } from 'vitest';

import { templateCard } from './ui.js';
import type { GroupTemplateInfo } from './readers/templates.js';

const template: GroupTemplateInfo = {
  status: 'ready',
  ref: 'education/knowledge-graph-tutor',
  mode: 'live',
  root: '/repo/templates/education/knowledge-graph-tutor',
  rootLabel: 'templates/education/knowledge-graph-tutor',
  referenceFile: 'groups/class/.nanoclaw-template.json',
  readme: true,
  instructions: { bytes: 1200, lines: 42 },
  contextExtras: [{ name: 'additional/faq.md', bytes: 512 }],
  skills: [{ name: 'learning-visuals', path: 'skills/learning-visuals' }],
  mcpServers: ['knowledge'],
  runtimeMounts: [{ source: 'app', target: '/workspace/agent/app', readonly: true }],
  opsCenter: {
    schema: 1,
    id: 'tutor-foundry',
    label: 'Tutor Foundry',
    icon: '⌁',
    entry: 'ops-center/index.ts',
    assets: 'ops-center/public',
    assetNames: ['app.js'],
  },
};

describe('Ops Center provenance UI', () => {
  it('shows template composition and live source drift', () => {
    const html = templateCard(template, {
      currentRuntimeFingerprint: 'current-fingerprint',
      latestRuntime: {
        schema: 2,
        generated_at: '2026-08-21T08:00:00.000Z',
        image: 'nanoclaw-agent:latest',
        image_fingerprint: 'image-fingerprint',
        agent_runner_fingerprint: 'runner-fingerprint',
        skills_fingerprint: 'skills-fingerprint',
        runtime_fingerprint: 'old-fingerprint',
      },
    });
    expect(html).toContain('education/knowledge-graph-tutor');
    expect(html).toContain('source changed');
    expect(html).toContain('learning-visuals');
    expect(html).toContain('knowledge');
    expect(html).toContain('Tutor Foundry');
  });

  it('explains ordinary groups without inventing a template', () => {
    const html = templateCard({
      ...template,
      status: 'none',
      ref: null,
      root: null,
      rootLabel: null,
      instructions: null,
      contextExtras: [],
      skills: [],
      mcpServers: [],
      runtimeMounts: [],
      opsCenter: null,
    });
    expect(html).toContain('No local template is attached');
    expect(html).not.toContain('knowledge-graph-tutor');
  });
});
