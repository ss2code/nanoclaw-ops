import { describe, expect, it } from 'vitest';

import { modelsCard } from './ui.js';

describe('Anthropic Models card', () => {
  it('offers the Anthropic aliases and pinned Haiku, Sonnet, and Opus releases', () => {
    const html = modelsCard(
      {
        id: 'jeeves-id',
        name: 'Jeeves',
        folder: 'jeeves',
        provider: 'claude',
        model: 'claude-sonnet-5',
        effort: null,
        cli_scope: 'global',
        image_tag: null,
        assistant_name: 'Jeeves',
        max_messages_per_prompt: null,
        skills: '"all"',
        mcp_servers: null,
        packages_apt: null,
        packages_npm: null,
        additional_mounts: null,
        hardening: null,
        model_tiers: JSON.stringify({
          high: 'claude-opus-5',
          medium: 'claude-sonnet-4-6',
          low: 'claude-haiku-4-5-20251001',
          default: 'medium',
        }),
        updated_at: null,
      },
      null,
    );

    for (const id of [
      'haiku',
      'claude-haiku-4-5-20251001',
      'sonnet',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'opus',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
    ]) {
      expect(html).toContain(`value="${id}"`);
    }
  });

  it('does not expose the OpenRouter catalog when the provider is Claude', () => {
    const html = modelsCard(
      {
        id: 'jeeves-id',
        name: 'Jeeves',
        folder: 'jeeves',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        effort: null,
        cli_scope: 'global',
        image_tag: null,
        assistant_name: 'Jeeves',
        max_messages_per_prompt: null,
        skills: '"all"',
        mcp_servers: null,
        packages_apt: null,
        packages_npm: null,
        additional_mounts: null,
        hardening: null,
        model_tiers: JSON.stringify({
          high: 'gpt-5.6-terra',
          medium: 'claude-sonnet-4-6',
          low: 'haiku',
          default: 'medium',
        }),
        updated_at: null,
      },
      {
        fetchedAt: Date.now(),
        source: 'test',
        models: [
          {
            id: 'openrouter/openai/gpt-5.6-terra',
            name: 'GPT Terra',
            contextWindow: 1,
            toolCapable: true,
            promptCost: 1,
            completionCost: 1,
            intelligenceIndex: 1,
          },
        ],
      },
    );

    expect(html).not.toContain('openrouter/openai/gpt-5.6-terra');
    expect(html).not.toContain('GPT Terra');
    expect(html).not.toContain('value="gpt-5.6-terra"');
  });
});
