import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import './index.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import type { ProviderContainerContext } from './provider-container-registry.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('OpenCode host container config', () => {
  it('lets a group model select its own upstream provider', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-'));
    tempDirs.push(sessionDir);
    const groupStateDir = path.join(DATA_DIR, 'v2-sessions', 'ag-grok-host-config-test');
    tempDirs.push(groupStateDir);
    const configure = getProviderContainerConfig('opencode');
    expect(configure).toBeDefined();

    const contribution = configure!({
      sessionDir,
      agentGroupId: 'ag-grok-host-config-test',
      groupDir: sessionDir,
      selectedSkills: [],
      hostEnv: {
        OPENCODE_PROVIDER: 'openrouter',
        OPENCODE_MODEL: 'openrouter/deepseek/deepseek-v4-flash-0731',
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
      },
      configuredModel: 'xai/grok-4.6',
    } as unknown as ProviderContainerContext);

    expect(contribution.env).toMatchObject({
      OPENCODE_PROVIDER: 'xai',
      OPENCODE_MODEL: 'xai/grok-4.6',
    });
    expect(contribution.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(contribution.mounts?.[0]).toMatchObject({
      hostPath: path.join(groupStateDir, 'opencode-xdg'),
      containerPath: '/opencode-xdg',
      readonly: false,
    });
  });

  it('preserves a canonical OpenRouter provider/model id', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-'));
    tempDirs.push(sessionDir);
    const configure = getProviderContainerConfig('opencode');
    expect(configure).toBeDefined();

    const contribution = configure!({
      sessionDir,
      agentGroupId: 'ag-openrouter-host-config-test',
      groupDir: sessionDir,
      selectedSkills: [],
      hostEnv: {
        OPENCODE_PROVIDER: 'openrouter',
        OPENCODE_MODEL: 'openrouter/deepseek/deepseek-v4-flash-0731',
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
      },
      configuredModel: 'openrouter/deepseek/deepseek-v4-flash-0731',
    } as unknown as ProviderContainerContext);

    expect(contribution.env).toMatchObject({
      OPENCODE_PROVIDER: 'openrouter',
      OPENCODE_MODEL: 'openrouter/deepseek/deepseek-v4-flash-0731',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
    });
  });
});
