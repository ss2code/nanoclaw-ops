import { afterEach, describe, expect, it } from 'bun:test';

import { buildOpenCodeConfig, OpenCodeProvider, resolveTurnModel } from './opencode.js';

const originalProvider = process.env.OPENCODE_PROVIDER;
const originalModel = process.env.OPENCODE_MODEL;
const originalSmallModel = process.env.OPENCODE_SMALL_MODEL;
const originalBaseURL = process.env.ANTHROPIC_BASE_URL;

afterEach(() => {
  if (originalProvider === undefined) delete process.env.OPENCODE_PROVIDER;
  else process.env.OPENCODE_PROVIDER = originalProvider;
  if (originalModel === undefined) delete process.env.OPENCODE_MODEL;
  else process.env.OPENCODE_MODEL = originalModel;
  if (originalSmallModel === undefined) delete process.env.OPENCODE_SMALL_MODEL;
  else process.env.OPENCODE_SMALL_MODEL = originalSmallModel;
  if (originalBaseURL === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = originalBaseURL;
});

describe('buildOpenCodeConfig', () => {
  it('maps a max effort request to each OpenRouter tier model\'s highest supported effort', () => {
    process.env.OPENCODE_PROVIDER = 'openrouter';

    const config = buildOpenCodeConfig({
      effort: 'max',
      modelTiers: {
        high: 'openrouter/z-ai/glm-5.2',
        medium: 'openrouter/minimax/minimax-m3',
        low: 'openrouter/openai/gpt-oss-120b',
        default: 'medium',
      },
    });

    const models = (config.provider as { openrouter: { models: Record<string, { options?: { reasoningEffort?: string } }> } })
      .openrouter.models;

    expect(models['z-ai/glm-5.2'].options?.reasoningEffort).toBe('xhigh');
    expect(models['openai/gpt-oss-120b'].options?.reasoningEffort).toBe('high');
    expect(models['minimax/minimax-m3'].options).toBeUndefined();
  });

  it('does not send an unsupported OpenRouter effort value', () => {
    process.env.OPENCODE_PROVIDER = 'openrouter';

    const config = buildOpenCodeConfig({
      effort: 'max',
      modelTiers: {
        high: 'openrouter/minimax/minimax-m3',
        medium: 'openrouter/minimax/minimax-m3',
        low: 'openrouter/minimax/minimax-m3',
        default: 'medium',
      },
    });

    const models = (config.provider as { openrouter: { models: Record<string, { options?: { reasoningEffort?: string } }> } })
      .openrouter.models;

    expect(models['minimax/minimax-m3'].options).toBeUndefined();
  });

  it('keeps the canonical provider/model id for an XAI OAuth model', () => {
    process.env.OPENCODE_PROVIDER = 'xai';
    process.env.OPENCODE_MODEL = 'xai/grok-4.6';

    const config = buildOpenCodeConfig({});
    expect(config.model).toBe('xai/grok-4.6');

    const models = (config.provider as { xai: { models: Record<string, { id?: string }> } }).xai.models;
    expect(models['grok-4.6']).toMatchObject({ id: 'grok-4.6' });
  });

  it('does not attach the global OpenRouter base URL to the native XAI provider', () => {
    process.env.OPENCODE_PROVIDER = 'xai';
    process.env.OPENCODE_MODEL = 'xai/grok-4.6';
    process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api/v1';

    const config = buildOpenCodeConfig({});
    const options = (config.provider as { xai: { options?: { baseURL?: string } } }).xai.options;

    expect(options?.baseURL).toBeUndefined();
  });

  it('keeps the OpenRouter base URL for the OpenRouter provider', () => {
    process.env.OPENCODE_PROVIDER = 'openrouter';
    process.env.OPENCODE_MODEL = 'openrouter/minimax/minimax-m3';
    process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api/v1';

    const config = buildOpenCodeConfig({});
    const options = (config.provider as { openrouter: { options?: { baseURL?: string } } }).openrouter.options;

    expect(options?.baseURL).toBe('https://openrouter.ai/api/v1');
  });
});

describe('resolveTurnModel', () => {
  const tiers = {
    high: 'openrouter/openai/gpt-5.6-luna-pro',
    medium: 'openrouter/minimax/minimax-m3',
    low: 'openrouter/openai/gpt-oss-120b',
    default: 'high',
  } as const;

  it('pins the default tier when no directive is present (regression: 2026-07-14 default ignored)', () => {
    // Omitting the model let OpenCode fall back to the session-creation model,
    // so the configured default tier never applied to untagged turns.
    const r = resolveTurnModel('what is your model name?', tiers, 'openrouter');
    expect(r.model).toEqual({ providerID: 'openrouter', modelID: 'openai/gpt-5.6-luna-pro' });
    expect(r.text).toBe('what is your model name?');
  });

  it('overrides with the named tier and strips the directive', () => {
    const r = resolveTurnModel('[tier:low] quick lookup', tiers, 'openrouter');
    expect(r.model).toEqual({ providerID: 'openrouter', modelID: 'openai/gpt-oss-120b' });
    expect(r.text).toBe('quick lookup');
  });

  it('tolerates whitespace inside the directive', () => {
    const r = resolveTurnModel('[tier: medium ] balanced task', tiers, 'openrouter');
    expect(r.model).toEqual({ providerID: 'openrouter', modelID: 'minimax/minimax-m3' });
    expect(r.text).toBe('balanced task');
  });

  it('returns no pin when the group has no tiers (env-var model applies)', () => {
    const r = resolveTurnModel('anything', undefined, 'openrouter');
    expect(r.model).toBeUndefined();
    expect(r.text).toBe('anything');
  });

  it('pins an XAI tier with the native provider id', () => {
    const r = resolveTurnModel(
      '[tier:low] quick lookup',
      {
        high: 'xai/grok-4.6',
        medium: 'xai/grok-4.5',
        low: 'xai/grok-4.3',
        default: 'medium',
      },
      'xai',
    );
    expect(r.model).toEqual({ providerID: 'xai', modelID: 'grok-4.3' });
    expect(r.text).toBe('quick lookup');
  });
});

describe('OpenCodeProvider session recovery', () => {
  it('treats encrypted-content decryption failures as stale continuations', () => {
    const provider = new OpenCodeProvider();
    const error = new Error(
      'invalid-argument: Could not decrypt the provided encrypted_content. Ensure the value is the unmodified encrypted_content from a previous response.',
    );

    expect(provider.isSessionInvalid(error)).toBe(true);
  });
});
