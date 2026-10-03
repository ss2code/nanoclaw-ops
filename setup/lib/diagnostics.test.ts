import { afterEach, describe, expect, it, vi } from 'vitest';

import { emit } from './diagnostics.js';

const saved = {
  key: process.env.NANOCLAW_POSTHOG_KEY,
  url: process.env.NANOCLAW_POSTHOG_URL,
  disabled: process.env.NANOCLAW_NO_DIAGNOSTICS,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries({
    NANOCLAW_POSTHOG_KEY: saved.key,
    NANOCLAW_POSTHOG_URL: saved.url,
    NANOCLAW_NO_DIAGNOSTICS: saved.disabled,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('diagnostics configuration', () => {
  it('does not send telemetry unless explicitly configured', () => {
    delete process.env.NANOCLAW_POSTHOG_KEY;
    delete process.env.NANOCLAW_POSTHOG_URL;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    emit('setup_complete');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses only the configured endpoint and project key', () => {
    process.env.NANOCLAW_POSTHOG_KEY = 'configured-key';
    process.env.NANOCLAW_POSTHOG_URL = 'https://telemetry.example.test/capture';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    emit('setup_complete', { ok: true });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://telemetry.example.test/capture',
      expect.objectContaining({ body: expect.stringContaining('configured-key') }),
    );
  });
});
