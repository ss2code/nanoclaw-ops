import fs from 'fs';
import path from 'path';

import { ensureWebChat, getWebChatState, readChatSlice, readContinuationProviders, sendViaCliSock } from './chat.js';
import { ROOT } from './config.js';
import type { GroupConfigSnapshot } from './readers/central.js';

export type SwitchableProvider = 'claude' | 'codex' | 'opencode' | 'pi';
export type TierName = 'high' | 'medium' | 'low';

export interface ProviderModelTiers {
  high: string;
  medium: string;
  low: string;
  default: TierName;
}

export interface ProviderProfile {
  provider: SwitchableProvider;
  model: string | null;
  modelTiers: ProviderModelTiers | null;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: SwitchableProvider;
  token: string;
  continuation: boolean;
  responsePreview: string | null;
  message: string;
}

export const PROVIDER_SWITCH_TEST_TIMEOUT_MS = 90_000;
export const PROVIDER_SWITCH_TEST_TOKEN = 'NANOCLAW_PROVIDER_SWITCH_OK';

const CODEX_DEFAULT_TIERS: ProviderModelTiers = {
  high: 'gpt-5.6-sol',
  medium: 'gpt-5.6-terra',
  low: 'gpt-5.6-luna',
  default: 'medium',
};

const CLAUDE_DEFAULT_TIERS: ProviderModelTiers = {
  high: 'claude-opus-4-8',
  medium: 'claude-sonnet-4-6',
  low: 'claude-haiku-4-5-20251001',
  default: 'medium',
};

function readOpenCodeModel(): string | undefined {
  try {
    const line = fs
      .readFileSync(path.join(ROOT, '.env'), 'utf8')
      .split('\n')
      .find((entry) => entry.trim().startsWith('OPENCODE_MODEL='));
    const value = line?.slice(line.indexOf('=') + 1).trim();
    return value &&
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value || undefined;
  } catch {
    return undefined;
  }
}

export function isSwitchableProvider(value: string | null | undefined): value is SwitchableProvider {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'pi';
}

export function providerProfileKind(provider: SwitchableProvider): string {
  return `provider_profile:${provider}`;
}

export function parseProviderTiers(raw: string | null | undefined): ProviderModelTiers | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ProviderModelTiers>;
    if (
      typeof value.high !== 'string' ||
      typeof value.medium !== 'string' ||
      typeof value.low !== 'string' ||
      !['high', 'medium', 'low'].includes(String(value.default))
    ) {
      return null;
    }
    return {
      high: value.high,
      medium: value.medium,
      low: value.low,
      default: value.default as TierName,
    };
  } catch {
    return null;
  }
}

function effectiveProfileModel(model: string | null, modelTiers: ProviderModelTiers | null): string | null {
  return modelTiers ? modelTiers[modelTiers.default] : model;
}

export function profileFromConfig(config: GroupConfigSnapshot): ProviderProfile {
  const provider = isSwitchableProvider(config.provider) ? config.provider : 'claude';
  const modelTiers = parseProviderTiers(config.model_tiers);
  return {
    provider,
    model: effectiveProfileModel(config.model, modelTiers),
    modelTiers,
  };
}

export function profileFromStoredConfig(
  config: Record<string, unknown>,
  provider: SwitchableProvider,
): ProviderProfile {
  const modelTiers = parseProviderTiers(typeof config.model_tiers === 'string' ? config.model_tiers : null);
  return {
    provider,
    model: effectiveProfileModel(typeof config.model === 'string' ? config.model : null, modelTiers),
    modelTiers,
  };
}

export function defaultProviderProfile(provider: SwitchableProvider, source?: ProviderProfile): ProviderProfile {
  if (provider === 'pi' && source && (source.provider === 'opencode' || source.provider === 'pi')) {
    const modelTiers = source.modelTiers ? { ...source.modelTiers } : null;
    return { provider, model: modelTiers ? modelTiers[modelTiers.default] : source.model, modelTiers };
  }
  if (provider === 'pi') {
    return {
      provider,
      model: process.env.OPENCODE_MODEL || readOpenCodeModel() || 'openrouter/deepseek/deepseek-v4-flash-0731',
      modelTiers: null,
    };
  }
  if (provider === 'opencode') {
    return {
      provider,
      model: process.env.OPENCODE_MODEL || readOpenCodeModel() || 'openrouter/deepseek/deepseek-v4-flash-0731',
      modelTiers: null,
    };
  }
  const modelTiers = provider === 'codex' ? CODEX_DEFAULT_TIERS : CLAUDE_DEFAULT_TIERS;
  return {
    provider,
    model: modelTiers[modelTiers.default],
    modelTiers: { ...modelTiers },
  };
}

export function providerSwitchPrompt(provider: SwitchableProvider): string {
  return [
    `Ops Center provider-switch validation for ${provider}.`,
    'Do not use tools or change files.',
    `Reply with the exact token ${PROVIDER_SWITCH_TEST_TOKEN} and one short sentence naming the provider you are running on.`,
  ].join(' ');
}

export function providerTestSucceeded(
  provider: SwitchableProvider,
  responseText: string | null,
  continuationProviders: string[],
): boolean {
  return Boolean(
    responseText?.includes(PROVIDER_SWITCH_TEST_TOKEN) &&
    continuationProviders.some((name) => name.toLowerCase() === provider),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send one isolated web-chat probe after a provider switch and require both a
 * fresh response token and the provider-specific continuation slot. This is a
 * deliberately small smoke test, not the ten-case live self-test suite.
 */
export async function validateProviderAfterRestart(
  groupId: string,
  groupName: string,
  provider: SwitchableProvider,
  timeoutMs = PROVIDER_SWITCH_TEST_TIMEOUT_MS,
): Promise<ProviderTestResult> {
  const token = PROVIDER_SWITCH_TEST_TOKEN;
  const wired = await ensureWebChat(groupId, groupName);
  if (!wired.ok) {
    return { ok: false, provider, token, continuation: false, responsePreview: null, message: wired.message };
  }

  const existing = getWebChatState(groupId);
  const baselineOut = existing.sessionDir ? readChatSlice(existing.sessionDir, 0, 0).outMax : 0;
  const sent = await sendViaCliSock(groupId, providerSwitchPrompt(provider));
  if (!sent.ok) {
    return { ok: false, provider, token, continuation: false, responsePreview: null, message: sent.message };
  }

  const deadline = Date.now() + timeoutMs;
  let responsePreview: string | null = null;
  let continuation = false;
  while (Date.now() < deadline) {
    const state = getWebChatState(groupId);
    if (state.sessionDir) {
      const slice = readChatSlice(state.sessionDir, 0, baselineOut);
      const response = [...slice.messages].reverse().find((m) => m.role === 'agent');
      responsePreview = response?.text.slice(0, 240) ?? responsePreview;
      const providers = readContinuationProviders(state.sessionDir);
      continuation = providers.some((name) => name.toLowerCase() === provider);
      if (providerTestSucceeded(provider, response?.text ?? null, providers)) {
        return {
          ok: true,
          provider,
          token,
          continuation: true,
          responsePreview,
          message: `${provider} answered the post-restart validation probe`,
        };
      }
    }
    await sleep(500);
  }

  return {
    ok: false,
    provider,
    token,
    continuation,
    responsePreview,
    message: `post-restart ${provider} probe timed out or returned without the validation token`,
  };
}
