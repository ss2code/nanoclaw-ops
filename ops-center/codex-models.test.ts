import { describe, expect, it } from 'vitest';

import { modelsCard } from './ui.js';

describe('Codex Models card', () => {
  it('renders Codex-native tier choices and never offers Anthropic models', () => {
    const html = modelsCard(
      {
        id: 'atlas-id',
        name: 'Atlas',
        folder: 'atlas',
        provider: 'codex',
        model: null,
        effort: 'xhigh',
        cli_scope: 'group',
        image_tag: null,
        assistant_name: 'Atlas',
        max_messages_per_prompt: null,
        skills: '"all"',
        mcp_servers: null,
        packages_apt: null,
        packages_npm: null,
        additional_mounts: null,
        hardening: null,
        model_tiers: JSON.stringify({
          high: 'claude-sonnet-4-6',
          medium: 'gpt-5.6-terra',
          low: 'gpt-5.6-luna',
          default: 'medium',
        }),
        updated_at: null,
      },
      null,
    );

    expect(html).toContain('Codex tier routing');
    expect(html).toContain('gpt-5.6-sol');
    expect(html).toContain('gpt-5.6-terra');
    expect(html).toContain('gpt-5.6-luna');
    expect(html).not.toContain('gpt-6-luna');
    expect(html).not.toContain('gpt-6-sol');
    expect(html).not.toContain('claude-opus');
  });

  it('does not expose the OpenRouter catalog when the provider is Codex', () => {
    const html = modelsCard(
      {
        id: 'atlas-id',
        name: 'Atlas',
        folder: 'atlas',
        provider: 'codex',
        model: null,
        effort: 'xhigh',
        cli_scope: 'group',
        image_tag: null,
        assistant_name: 'Atlas',
        max_messages_per_prompt: null,
        skills: '"all"',
        mcp_servers: null,
        packages_apt: null,
        packages_npm: null,
        additional_mounts: null,
        hardening: null,
        model_tiers: JSON.stringify({
          high: 'gpt-5.6-sol',
          medium: 'gpt-5.6-terra',
          low: 'gpt-5.6-luna',
          default: 'medium',
        }),
        updated_at: null,
      },
      {
        fetchedAt: Date.now(),
        source: 'test',
        models: [
          {
            id: 'openrouter/anthropic/claude-sonnet-4-6',
            name: 'Claude Sonnet',
            contextWindow: 1,
            toolCapable: true,
            promptCost: 1,
            completionCost: 1,
            intelligenceIndex: 1,
          },
        ],
      },
    );

    expect(html).not.toContain('openrouter/anthropic/claude-sonnet-4-6');
    expect(html).not.toContain('Claude Sonnet');
    expect(html).not.toContain('value="claude-sonnet-4-6"');
  });
});
