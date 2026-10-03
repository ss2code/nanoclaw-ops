import { describe, expect, it, vi } from 'vitest';

import { checkOneCliHealth, OneCliHealthError, oneCliHealthUrl, OneCliWakeCircuit } from './onecli-health.js';

describe('OneCLI health probe', () => {
  it('builds the versioned endpoint without duplicating /v1', () => {
    expect(oneCliHealthUrl('http://127.0.0.1:10254')).toBe('http://127.0.0.1:10254/v1/health');
    expect(oneCliHealthUrl('https://vault.example/v1/')).toBe('https://vault.example/v1/health');
  });

  it.each([
    [404, 'incompatible'],
    [401, 'unauthorized'],
    [503, 'unhealthy'],
  ] as const)('classifies HTTP %s as %s', async (status, kind) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status }));

    await expect(checkOneCliHealth('http://onecli.test', { fetchImpl })).rejects.toMatchObject({ kind, status });
  });

  it('classifies a fetch failure as unreachable and honors the endpoint', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    });

    await expect(checkOneCliHealth('http://onecli.test', { fetchImpl })).rejects.toMatchObject({
      kind: 'unreachable',
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://onecli.test/v1/health', expect.anything());
  });

  it('rejects a missing URL as configuration failure', async () => {
    await expect(checkOneCliHealth(undefined)).rejects.toBeInstanceOf(OneCliHealthError);
    await expect(checkOneCliHealth(undefined)).rejects.toMatchObject({ kind: 'configuration' });
  });

  it('accepts a healthy response', async () => {
    const result = await checkOneCliHealth('http://onecli.test', {
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
    });
    expect(result).toEqual({ url: 'http://onecli.test/v1/health', status: 204 });
  });
});

describe('OneCliWakeCircuit', () => {
  it('backs off successive failures and resets after success', () => {
    const circuit = new OneCliWakeCircuit();

    expect(circuit.canAttempt(1_000)).toBe(true);
    circuit.recordFailure('unreachable', 1_000);
    expect(circuit.canAttempt(5_999)).toBe(false);
    expect(circuit.retryAfterMs(1_000)).toBe(5_000);
    expect(circuit.snapshot()).toMatchObject({ consecutiveFailures: 1, lastFailureKind: 'unreachable' });

    circuit.recordFailure('unreachable', 7_000);
    expect(circuit.retryAfterMs(7_000)).toBe(15_000);
    expect(circuit.snapshot().consecutiveFailures).toBe(2);

    circuit.recordSuccess();
    expect(circuit.canAttempt(7_001)).toBe(true);
    expect(circuit.snapshot()).toEqual({ consecutiveFailures: 0, blockedUntil: 0, lastFailureKind: null });
  });

  it('caps the backoff rather than growing without bound', () => {
    const circuit = new OneCliWakeCircuit();
    for (let i = 0; i < 20; i++) circuit.recordFailure('unhealthy', i * 1_000_000);

    expect(circuit.snapshot().blockedUntil - 19_000_000).toBe(120_000);
  });
});
