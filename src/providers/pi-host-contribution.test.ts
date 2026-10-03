import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, DATA_DIR, GROUPS_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const root = '/tmp/nanoclaw-pi-host-contribution-test';
  return { TEST_ROOT: root, DATA_DIR: nodePath.join(root, 'data'), GROUPS_DIR: nodePath.join(root, 'groups') };
});

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR,
  GROUPS_DIR,
}));

import { buildMounts } from '../container-runner.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import type { ContainerConfig } from '../container-config.js';
import type { AgentGroup, Session } from '../types.js';
import './index.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

describe('Pi host contribution', () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('creates group-scoped auth state, composes AGENTS.md, and keeps sessions under the session mount', () => {
    const ag = group('ag-pi', 'pi-group');
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);
    updateContainerConfigJson(ag.id, 'mcp_servers', {
      tooling: { command: 'tooling-mcp', instructions: 'use this server for live tooling' },
    });
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const contribution = getProviderContainerConfig('pi')!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: ['welcome'],
      configuredModel: 'openrouter/deepseek/deepseek-v4',
      hostEnv: { HTTPS_PROXY: 'http://gateway.invalid' },
    });

    const shared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.pi-shared');
    expect(contribution.mounts).toContainEqual({
      hostPath: shared,
      containerPath: '/home/node/.pi/agent',
      readonly: false,
    });
    expect(contribution.env).toMatchObject({ OPENROUTER_API_KEY: 'onecli-managed' });
    expect(contribution.env).not.toHaveProperty('XAI_API_KEY');
    expect(fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf8')).toContain('MCP Server: tooling');
    expect(fs.lstatSync(path.join(shared, 'skills', 'welcome')).isSymbolicLink()).toBe(true);

    const config: ContainerConfig = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    };
    const mounts = buildMounts(ag, { id: 'session-1', agent_group_id: ag.id } as Session, config, 'pi', contribution);
    const paths = mounts.map((mount) => mount.containerPath);
    expect(paths).toContain('/home/node/.pi/agent');
    expect(paths).toContain('/workspace/agent/AGENTS.md');
    expect(paths).not.toContain('/home/node/.claude');
  });

  it('keeps xAI subscription auth provider-owned without exposing an API-key placeholder', () => {
    const ag = group('ag-grok', 'grok-group');
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);
    const contribution = getProviderContainerConfig('pi')!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: [],
      configuredModel: 'xai/grok-4.6',
      hostEnv: {},
    });
    expect(contribution.env).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(contribution.env).not.toHaveProperty('XAI_API_KEY');
  });
});
