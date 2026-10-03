import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { providerAuthDaysRemaining, providerAuthState, readProviderAuthStatus } from './readers/provider-auth.js';
import { providerAuthCard } from './ui.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-auth-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('provider auth receipt reader', () => {
  it('reads non-secret receipts and returns empty state for missing files', () => {
    const missing = readProviderAuthStatus(path.join(tmp, 'missing.json'));
    expect(missing).toEqual({ claude: null, codex: null, xai: null, openrouter: null });

    const file = path.join(tmp, 'provider-auth-status.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        providers: {
          claude: {
            method: 'Claude setup-token subscription login',
            refreshedAt: '2026-08-21T00:00:00.000Z',
            expiresAt: '2027-08-21T00:00:00.000Z',
            expiryMode: 'estimated',
            note: 'estimate',
          },
          codex: {
            method: 'ChatGPT device-code login',
            refreshedAt: '2026-08-21T00:00:00.000Z',
            expiresAt: null,
            expiryMode: 'provider-managed',
            note: 'managed',
          },
          xai: {
            method: 'Pi xAI SuperGrok subscription OAuth',
            refreshedAt: '2026-08-21T00:00:00.000Z',
            expiresAt: null,
            expiryMode: 'provider-managed',
            note: 'Pi-managed',
          },
          openrouter: {
            method: 'OpenRouter OneCLI API-key connectivity check',
            refreshedAt: '2026-08-21T00:00:00.000Z',
            expiresAt: null,
            expiryMode: 'no-known-expiry',
            note: 'key check',
          },
        },
      }),
    );
    const state = readProviderAuthStatus(file);
    expect(state.claude?.method).toContain('Claude');
    expect(state.codex?.expiryMode).toBe('provider-managed');
    expect(state.xai?.method).toContain('SuperGrok');
    expect(state.openrouter?.expiryMode).toBe('no-known-expiry');
  });

  it('classifies estimated expiry and provider-managed credentials', () => {
    const now = Date.parse('2026-08-21T00:00:00.000Z');
    const soon = {
      method: 'test',
      refreshedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-25T00:00:00.000Z',
      expiryMode: 'estimated' as const,
      note: '',
    };
    const managed = { ...soon, expiresAt: null, expiryMode: 'provider-managed' as const };
    expect(providerAuthState(soon, now)).toBe('soon');
    expect(providerAuthDaysRemaining(soon, now)).toBe(4);
    expect(providerAuthState(managed, now)).toBe('provider-managed');
  });

  it('renders clear SSH instructions and expiry semantics', () => {
    const now = Date.parse('2026-08-21T00:00:00.000Z');
    const html = providerAuthCard(
      {
        claude: {
          method: 'Claude setup-token subscription login',
          refreshedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-08-25T00:00:00.000Z',
          expiryMode: 'estimated',
          note: 'estimate',
        },
        codex: {
          method: 'ChatGPT device-code login',
          refreshedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: null,
          expiryMode: 'provider-managed',
          note: 'managed',
        },
        xai: {
          method: 'Pi xAI SuperGrok subscription OAuth',
          refreshedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: null,
          expiryMode: 'provider-managed',
          note: 'Pi-managed',
        },
        openrouter: {
          method: 'OpenRouter OneCLI API-key connectivity check',
          refreshedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: null,
          expiryMode: 'no-known-expiry',
          note: 'key check',
        },
      },
      now,
    );
    expect(html).toContain('Provider authentication expiry');
    expect(html).toContain('estimated');
    expect(html).toContain('4d remaining');
    expect(html).toContain('provider-managed');
    expect(html).toContain('./scripts/reauth-claude.sh');
    expect(html).toContain('./scripts/reauth-codex.sh');
    expect(html).toContain('XAI / Grok');
    expect(html).toContain('./scripts/reauth-xai.sh');
    expect(html).toContain('./scripts/reauth-openrouter.sh --check');
    expect(html).toContain('OpenRouter');
  });
});
