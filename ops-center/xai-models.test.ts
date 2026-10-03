import { describe, expect, it } from 'vitest';

import { modelsCard } from './ui.js';

describe('XAI OpenCode Models card', () => {
  it('offers native XAI models instead of OpenRouter catalog entries', () => {
    const html = modelsCard(
      {
        id: 'grok-id',
        name: 'Grok',
        folder: 'grok',
        provider: 'opencode',
        model: 'xai/grok-4.6',
        effort: null,
        cli_scope: 'group',
        image_tag: null,
        assistant_name: 'Grok',
        max_messages_per_prompt: null,
        skills: '"all"',
        mcp_servers: null,
        packages_apt: null,
        packages_npm: null,
        additional_mounts: null,
        hardening: null,
        model_tiers: null,
        updated_at: null,
      },
      {
        fetchedAt: Date.now(),
        source: 'test',
        models: [
          {
            id: 'openrouter/anthropic/claude-opus-5',
            name: 'Claude Opus',
            contextWindow: 1,
            toolCapable: true,
            promptCost: 1,
            completionCost: 1,
            intelligenceIndex: 100,
          },
        ],
      },
    );

    expect(html).toContain('opencode / xAI');
    expect(html).toContain('SuperGrok OAuth');
    expect(html).toContain('value="xai/grok-4.7"');
    expect(html).toContain('value="xai/grok-4.6"');
    expect(html).toContain('Grok 4.5');
    expect(html).not.toContain('Claude Opus');
    expect(html).not.toContain('openrouter/anthropic/claude-opus-5');
    expect(html).not.toContain('Browse catalog');
  });
});
