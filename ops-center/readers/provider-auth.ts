/**
 * Read the non-secret provider-auth receipt written by the SSH re-auth scripts.
 *
 * This file deliberately does not inspect OneCLI secret values. The receipt
 * contains only method labels, timestamps, and expiry semantics. Claude's
 * setup-token date is an estimate; Codex and XAI are provider-managed in this
 * workflow. OpenRouter is an API-key connectivity receipt, not OAuth.
 */
import fs from 'fs';

import { PATHS } from '../config.js';

export type ProviderAuthExpiryMode = 'estimated' | 'provider-managed' | 'no-known-expiry';

export interface ProviderAuthRecord {
  method: string;
  refreshedAt: string;
  expiresAt: string | null;
  expiryMode: ProviderAuthExpiryMode;
  note: string;
}

export type ProviderAuthStatus = Record<'claude' | 'codex' | 'xai' | 'openrouter', ProviderAuthRecord | null>;

const EMPTY: ProviderAuthStatus = { claude: null, codex: null, xai: null, openrouter: null };

function record(value: unknown): ProviderAuthRecord | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.method !== 'string' || typeof row.refreshedAt !== 'string') return null;
  const mode = row.expiryMode;
  if (mode !== 'estimated' && mode !== 'provider-managed' && mode !== 'no-known-expiry') return null;
  return {
    method: row.method,
    refreshedAt: row.refreshedAt,
    expiresAt: typeof row.expiresAt === 'string' ? row.expiresAt : null,
    expiryMode: mode,
    note: typeof row.note === 'string' ? row.note : '',
  };
}

export function readProviderAuthStatus(file = PATHS.providerAuthStatus): ProviderAuthStatus {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { providers?: Record<string, unknown> };
    return {
      claude: record(parsed.providers?.claude),
      codex: record(parsed.providers?.codex),
      xai: record(parsed.providers?.xai),
      openrouter: record(parsed.providers?.openrouter),
    };
  } catch {
    return { ...EMPTY };
  }
}

export type ProviderAuthState = 'missing' | 'expired' | 'soon' | 'valid' | 'provider-managed' | 'no-known-expiry';

export function providerAuthState(
  auth: ProviderAuthRecord | null,
  now = Date.now(),
  warningWindowMs = 30 * 24 * 60 * 60 * 1000,
): ProviderAuthState {
  if (!auth) return 'missing';
  if (auth.expiryMode === 'provider-managed') return 'provider-managed';
  if (auth.expiryMode === 'no-known-expiry') return 'no-known-expiry';
  const expires = Date.parse(auth.expiresAt ?? '');
  if (!Number.isFinite(expires)) return 'missing';
  if (expires <= now) return 'expired';
  return expires - now <= warningWindowMs ? 'soon' : 'valid';
}

export function providerAuthDaysRemaining(auth: ProviderAuthRecord | null, now = Date.now()): number | null {
  if (!auth?.expiresAt) return null;
  const expires = Date.parse(auth.expiresAt);
  if (!Number.isFinite(expires)) return null;
  return Math.ceil((expires - now) / (24 * 60 * 60 * 1000));
}
