export type LifecyclePhase = 'cold-baseline' | 'cold-start' | 'hard-shutdown' | 'restart' | 'failure-recovery';

export interface LifecycleCycleDriver {
  preflight(): Promise<unknown>;
  hardOff(phase: LifecyclePhase): Promise<unknown>;
  assertStopped(phase: LifecyclePhase): Promise<unknown>;
  start(phase: LifecyclePhase): Promise<unknown>;
  assertReady(phase: LifecyclePhase): Promise<unknown>;
  probeAgent(phase: LifecyclePhase): Promise<unknown>;
}

export interface LifecycleCycleStep {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface LifecycleCycleReport {
  ok: boolean;
  recovered: boolean;
  steps: LifecycleCycleStep[];
}

export async function runFullLifecycleCycle(
  driver: LifecycleCycleDriver,
  log: (message: string) => void = () => undefined,
): Promise<LifecycleCycleReport> {
  const steps: LifecycleCycleStep[] = [];
  let destructivePhaseStarted = false;

  const run = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    const startedAt = Date.now();
    log(`▶ ${name}`);
    try {
      await action();
      steps.push({ name, ok: true, durationMs: Date.now() - startedAt });
      log(`✓ ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ name, ok: false, durationMs: Date.now() - startedAt, error: message });
      log(`✗ ${name}: ${message}`);
      throw error;
    }
  };

  try {
    await run('preflight', () => driver.preflight());
    destructivePhaseStarted = true;
    await run('hard-off cold baseline', () => driver.hardOff('cold-baseline'));
    await run('verify cold baseline stopped', () => driver.assertStopped('cold-baseline'));
    await run('cold start', () => driver.start('cold-start'));
    await run('verify cold-start dependencies', () => driver.assertReady('cold-start'));
    await run('cold-start agent response', () => driver.probeAgent('cold-start'));
    await run('hard shutdown', () => driver.hardOff('hard-shutdown'));
    await run('verify hard shutdown', () => driver.assertStopped('hard-shutdown'));
    await run('restart', () => driver.start('restart'));
    await run('verify restart dependencies', () => driver.assertReady('restart'));
    await run('post-restart agent response', () => driver.probeAgent('restart'));
    return { ok: true, recovered: false, steps };
  } catch {
    if (!destructivePhaseStarted) return { ok: false, recovered: false, steps };
    try {
      await run('failure recovery start', () => driver.start('failure-recovery'));
      await run('verify failure recovery', () => driver.assertReady('failure-recovery'));
      return { ok: false, recovered: true, steps };
    } catch {
      return { ok: false, recovered: false, steps };
    }
  }
}
