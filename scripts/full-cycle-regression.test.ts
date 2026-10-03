import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { runFullLifecycleCycle, type LifecycleCycleDriver } from './full-cycle-regression-lib.js';

describe('full lifecycle regression', () => {
  it('ships an executable, confirmation-gated macro wrapper', () => {
    const wrapper = path.join(process.cwd(), 'bin', 'nanoclaw-lifecycle-test');
    const wrapperSource = fs.readFileSync(wrapper, 'utf8');
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'full-cycle-regression.ts'), 'utf8');
    expect(fs.statSync(wrapper).mode & 0o111).not.toBe(0);
    expect(wrapperSource).toContain('resolve-node.sh');
    expect(wrapperSource).toContain('node_modules/tsx/dist/cli.mjs');
    expect(script).toContain("if (!has('yes'))");
    expect(script).toContain('Reply with exactly this token');
  });

  it('proves cold start, hard-off, restart, dependencies, and two real-response probes in order', async () => {
    const calls: string[] = [];
    const driver: LifecycleCycleDriver = {
      preflight: async () => calls.push('preflight'),
      hardOff: async (phase) => calls.push(`hard-off:${phase}`),
      assertStopped: async (phase) => calls.push(`stopped:${phase}`),
      start: async (phase) => calls.push(`start:${phase}`),
      assertReady: async (phase) => calls.push(`ready:${phase}`),
      probeAgent: async (phase) => calls.push(`probe:${phase}`),
    };

    const report = await runFullLifecycleCycle(driver);

    expect(report.ok).toBe(true);
    expect(calls).toEqual([
      'preflight',
      'hard-off:cold-baseline',
      'stopped:cold-baseline',
      'start:cold-start',
      'ready:cold-start',
      'probe:cold-start',
      'hard-off:hard-shutdown',
      'stopped:hard-shutdown',
      'start:restart',
      'ready:restart',
      'probe:restart',
    ]);
  });

  it('attempts recovery to a running state when a destructive phase fails', async () => {
    const calls: string[] = [];
    const driver: LifecycleCycleDriver = {
      preflight: async () => calls.push('preflight'),
      hardOff: async (phase) => calls.push(`hard-off:${phase}`),
      assertStopped: async () => {
        calls.push('stopped:fail');
        throw new Error('stopped assertion failed');
      },
      start: async (phase) => calls.push(`start:${phase}`),
      assertReady: async (phase) => calls.push(`ready:${phase}`),
      probeAgent: async (phase) => calls.push(`probe:${phase}`),
    };

    const report = await runFullLifecycleCycle(driver);

    expect(report.ok).toBe(false);
    expect(report.recovered).toBe(true);
    expect(calls.slice(-2)).toEqual(['start:failure-recovery', 'ready:failure-recovery']);
  });
});
