import { describe, expect, it } from 'vitest';

import { configFromDb } from './container-config.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

const group = { id: 'ag-class-7-maths', name: 'Class 7 Maths Tutor', folder: 'class-7-maths' } as AgentGroup;

const baseRow: ContainerConfigRow = {
  agent_group_id: group.id,
  provider: 'claude',
  model: 'gpt-5.6-terra',
  effort: null,
  image_tag: null,
  assistant_name: null,
  max_messages_per_prompt: null,
  skills: '"all"',
  mcp_servers: '{}',
  packages_apt: '[]',
  packages_npm: '[]',
  additional_mounts: '[]',
  cli_scope: 'group',
  hardening: null,
  model_tiers: JSON.stringify({
    high: 'claude-sonnet-5',
    medium: 'claude-sonnet-4-6',
    low: 'haiku',
    default: 'medium',
  }),
  updated_at: '2026-08-19T00:00:00Z',
};

describe('container config model materialization', () => {
  it('instantiates the default tier instead of a stale scalar model', () => {
    const config = configFromDb(baseRow, group);

    expect(config.provider).toBe('claude');
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.model).not.toBe(baseRow.model);
  });
});
