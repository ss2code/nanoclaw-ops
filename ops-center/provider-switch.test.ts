import { describe, expect, it } from 'vitest';

import { buildGroupProviderArgs } from './lifecycle.js';
import {
  defaultProviderProfile,
  isSwitchableProvider,
  parseProviderTiers,
  profileFromConfig,
  profileFromStoredConfig,
  providerTestSucceeded,
  providerSwitchPrompt,
} from './provider-switch.js';
import { providerSwitchCard } from './ui.js';
import type { GroupConfigSnapshot } from './readers/central.js';

const claudeConfig: GroupConfigSnapshot = {
  id: 'ag-trip',
  name: 'Sample Trip',
  folder: 'sample-trip',
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  cli_scope: 'global',
  effort: null,
  image_tag: null,
  assistant_name: 'Sample Trip',
  max_messages_per_prompt: null,
  skills: '"all"',
  mcp_servers: null,
  packages_apt: null,
  packages_npm: null,
  additional_mounts: null,
  hardening: null,
  model_tiers: JSON.stringify({
    high: 'claude-opus-4-8',
    medium: 'claude-sonnet-4-6',
    low: 'claude-haiku-4-5-20251001',
    default: 'medium',
  }),
  updated_at: null,
};

describe('provider switch controls', () => {
  it('builds a provider update that carries the target model profile', () => {
    expect(
      buildGroupProviderArgs('ag-trip', {
        provider: 'codex',
        model: 'gpt-5.6-terra',
        modelTiers: {
          high: 'gpt-5.6-sol',
          medium: 'gpt-5.6-terra',
          low: 'gpt-5.6-luna',
          default: 'medium',
        },
      }),
    ).toEqual([
      'groups',
      'config',
      'update',
      '--id',
      'ag-trip',
      '--provider',
      'codex',
      '--model',
      'gpt-5.6-terra',
      '--model-tiers',
      JSON.stringify({
        high: 'gpt-5.6-sol',
        medium: 'gpt-5.6-terra',
        low: 'gpt-5.6-luna',
        default: 'medium',
      }),
    ]);
  });

  it('emits an explicit model clear when the target profile is tier-only', () => {
    expect(
      buildGroupProviderArgs('ag-trip', {
        provider: 'claude',
        model: null,
        modelTiers: null,
      }),
    ).toEqual([
      'groups',
      'config',
      'update',
      '--id',
      'ag-trip',
      '--provider',
      'claude',
      '--model',
      'none',
      '--model-tiers',
      'none',
    ]);
  });

  it('provides native first-visit defaults without changing the source profile', () => {
    const codex = defaultProviderProfile('codex');
    expect(codex.model).toBe('gpt-5.6-terra');
    expect(codex.modelTiers?.high).toBe('gpt-5.6-sol');
    expect(parseProviderTiers(claudeConfig.model_tiers)).toMatchObject({ default: 'medium' });

    const opencode = defaultProviderProfile('opencode');
    expect(opencode.model).toMatch(/\//);
    expect(opencode.modelTiers).toBeNull();
    expect(isSwitchableProvider('opencode')).toBe(true);

    const pi = defaultProviderProfile('pi', {
      provider: 'opencode',
      model: 'xai/grok-4.6',
      modelTiers: {
        high: 'xai/grok-4.6', medium: 'xai/grok-4.5', low: 'xai/grok-4.3', default: 'medium',
      },
    });
    expect(pi).toMatchObject({ provider: 'pi', model: 'xai/grok-4.5' });
    expect(pi.modelTiers?.high).toBe('xai/grok-4.6');
    expect(isSwitchableProvider('pi')).toBe(true);
  });

  it('uses the selected tier as the saved profile model when the scalar is stale', () => {
    const config = { ...claudeConfig, model: 'gpt-5.6-terra' };
    expect(profileFromConfig(config).model).toBe('claude-sonnet-4-6');
    expect(
      profileFromStoredConfig({ model: 'gpt-5.6-terra', model_tiers: claudeConfig.model_tiers }, 'claude').model,
    ).toBe('claude-sonnet-4-6');
  });

  it('requires both the response token and provider continuation', () => {
    const prompt = providerSwitchPrompt('codex');
    expect(prompt).toContain('NANOCLAW_PROVIDER_SWITCH_OK');
    expect(providerTestSucceeded('codex', 'NANOCLAW_PROVIDER_SWITCH_OK — Codex', ['claude'])).toBe(false);
    expect(providerTestSucceeded('codex', 'NANOCLAW_PROVIDER_SWITCH_OK — Codex', ['codex'])).toBe(true);
    expect(providerTestSucceeded('pi', 'NANOCLAW_PROVIDER_SWITCH_OK — Pi', ['pi'])).toBe(true);
  });

  it('renders the reversible switch on the detailed group page', () => {
    const html = providerSwitchCard(claudeConfig);
    expect(html).toContain('Harness / provider');
    expect(html).toContain('current model');
    expect(html).toContain('Use Codex / ChatGPT');
    expect(html).toContain('Use OpenCode / OpenRouter');
    expect(html).toContain('Use Pi');
    expect(html).toContain('/api/group/ag-trip/provider');
    expect(html).toContain('one validation model turn');
  });

  it('identifies an XAI-backed OpenCode group in the harness switcher', () => {
    const html = providerSwitchCard({
      ...claudeConfig,
      id: 'ag-grok',
      name: 'Grok',
      folder: 'grok',
      provider: 'opencode',
      model: 'xai/grok-4.6',
      model_tiers: null,
    });

    expect(html).toContain('active harness <b>OpenCode / xAI</b>');
    expect(html).toContain('xai/grok-4.6');
    expect(html).toContain('SuperGrok OAuth');
  });
});
