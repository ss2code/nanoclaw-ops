import { describe, expect, it } from 'bun:test';

import { MessageStream, compactBoundaryProgress, extractSubagentSpawn, resolveTierDirective } from './claude.js';
import type { ModelTiers } from './types.js';

describe('extractSubagentSpawn', () => {
  // Real SDK stream events nest the API message under `message`:
  // { type: 'assistant', message: { content: [...] } }. Fixtures here use that
  // shape — a flat `content` fixture would pass while production silently
  // extracted nothing (the 2026-07-14 daily-update RCA).
  it('extracts an Agent tool call from an SDK-shaped assistant event', () => {
    const spawns = extractSubagentSpawn({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Agent',
            input: {
              description: 'Quick URL lookup for trip references',
              subagent_type: 'Explore',
              prompt: 'Find verified URLs.',
            },
          },
        ],
      },
    });

    expect(spawns).toEqual([{ model: 'haiku', reason: 'Quick URL lookup for trip references' }]);
  });

  it('prefers explicit model when the SDK provides one', () => {
    const spawns = extractSubagentSpawn({
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Task',
            input: {
              description: 'Complex design check',
              model: 'opus',
            },
          },
        ],
      },
    });

    expect(spawns).toEqual([{ model: 'opus', reason: 'Complex design check' }]);
  });

  it('still accepts a flat message shape', () => {
    const spawns = extractSubagentSpawn({
      content: [{ type: 'tool_use', name: 'Agent', input: { description: 'Flat-shape spawn', model: 'haiku' } }],
    });

    expect(spawns).toEqual([{ model: 'haiku', reason: 'Flat-shape spawn' }]);
  });

  it('ignores non-subagent tool calls', () => {
    expect(
      extractSubagentSpawn({
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo nope' } }],
        },
      }),
    ).toEqual([]);
  });
});

describe('resolveTierDirective', () => {
  const tiers: ModelTiers = {
    high: 'claude-opus-4-8',
    medium: 'claude-sonnet-5',
    low: 'claude-haiku-4-5-20251001',
    default: 'medium',
  };

  it('returns null without tiers configured, even when the tag is present', () => {
    expect(resolveTierDirective('do it [tier:high]', undefined)).toBeNull();
  });

  it('returns null when no directive is present', () => {
    expect(resolveTierDirective('just a message', tiers)).toBeNull();
  });

  it('resolves the tier model and strips the directive from the prompt', () => {
    const r = resolveTierDirective('<messages>think hard [tier:high] about this</messages>', tiers);
    expect(r?.tier).toBe('high');
    expect(r?.model).toBe('claude-opus-4-8');
    expect(r?.prompt).toBe('<messages>think hard  about this</messages>');
  });

  it('is case- and whitespace-insensitive', () => {
    const r = resolveTierDirective('[ that is not it ] [Tier: LOW ] fetch stuff', tiers);
    expect(r?.model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('compactBoundaryProgress', () => {
  it('treats compact_boundary as progress, not turn completion', () => {
    expect(compactBoundaryProgress(123456)).toEqual({
      type: 'progress',
      message: 'Context compacted (123,456 tokens compacted).',
    });
  });
});

describe('MessageStream follow-up disposition', () => {
  it('coalesces input pushed before the active turn result and separates later input', () => {
    const stream = new MessageStream();

    expect(stream.push('initial prompt')).toBe('separate');
    expect(stream.push('follow-up while active')).toBe('coalesced');

    stream.markTurnComplete();

    expect(stream.push('follow-up after result')).toBe('separate');
  });
});

describe('ClaudeProvider.prefersFreshQuery', () => {
  it('is true only for directive-bearing text', async () => {
    const { ClaudeProvider } = await import('./claude.js');
    const withTiers = new ClaudeProvider({
      modelTiers: { high: 'claude-opus-4-8', medium: 'claude-sonnet-5', low: 'claude-haiku-4-5-20251001', default: 'medium' },
    });
    expect(withTiers.prefersFreshQuery('{"text":"do it [tier:high]"}')).toBe(true);
    expect(withTiers.prefersFreshQuery('{"text":"plain message"}')).toBe(false);
  });

  it('falls back to the built-in Anthropic ladder when no tiers are configured', async () => {
    const { ClaudeProvider } = await import('./claude.js');
    const noTiers = new ClaudeProvider({});
    expect(noTiers.prefersFreshQuery('do it [tier:high]')).toBe(true);
    expect(noTiers.prefersFreshQuery('plain message')).toBe(false);
  });
});
