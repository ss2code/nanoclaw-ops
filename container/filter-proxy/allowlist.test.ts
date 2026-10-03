import { describe, expect, it } from 'vitest';

import { hostAllowed, parseAllowlist, parseConnectTarget } from './allowlist.ts';

describe('parseAllowlist', () => {
  it('splits, trims, lowercases, drops empties', () => {
    expect(parseAllowlist(' OpenRouter.ai , ,*.Example.com,')).toEqual(['openrouter.ai', '*.example.com']);
  });

  it('handles undefined/empty', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
  });
});

describe('hostAllowed', () => {
  const patterns = ['openrouter.ai', '*.googleapis.com'];

  it('matches exact hosts case-insensitively', () => {
    expect(hostAllowed('openrouter.ai', patterns)).toBe(true);
    expect(hostAllowed('OpenRouter.AI', patterns)).toBe(true);
  });

  it('refuses non-listed hosts', () => {
    expect(hostAllowed('example.com', patterns)).toBe(false);
    expect(hostAllowed('evil.com', patterns)).toBe(false);
  });

  it('wildcard matches subdomains only, not the apex', () => {
    expect(hostAllowed('gmail.googleapis.com', patterns)).toBe(true);
    expect(hostAllowed('a.b.googleapis.com', patterns)).toBe(true);
    expect(hostAllowed('googleapis.com', patterns)).toBe(false);
  });

  it('refuses suffix-smuggling lookalikes', () => {
    expect(hostAllowed('evilopenrouter.ai', patterns)).toBe(false);
    expect(hostAllowed('openrouter.ai.evil.com', patterns)).toBe(false);
    expect(hostAllowed('notgoogleapis.com', patterns)).toBe(false);
  });

  it('exact pattern does not cover subdomains', () => {
    expect(hostAllowed('api.openrouter.ai', patterns)).toBe(false);
  });

  it('normalizes trailing dots (DNS root form)', () => {
    expect(hostAllowed('openrouter.ai.', patterns)).toBe(true);
  });

  it('empty allowlist refuses everything', () => {
    expect(hostAllowed('openrouter.ai', [])).toBe(false);
  });
});

describe('parseConnectTarget', () => {
  it('parses host:port', () => {
    expect(parseConnectTarget('openrouter.ai:443')).toEqual({ host: 'openrouter.ai', port: 443 });
  });

  it('lowercases the host', () => {
    expect(parseConnectTarget('OpenRouter.AI:443')).toEqual({ host: 'openrouter.ai', port: 443 });
  });

  it('rejects malformed targets', () => {
    expect(parseConnectTarget('openrouter.ai')).toBeNull();
    expect(parseConnectTarget('openrouter.ai:0')).toBeNull();
    expect(parseConnectTarget('openrouter.ai:70000')).toBeNull();
    expect(parseConnectTarget('[::1]:443')).toBeNull();
    expect(parseConnectTarget('host with space:443')).toBeNull();
    expect(parseConnectTarget('')).toBeNull();
  });
});
