import { describe, expect, it } from 'vitest';

import { openOpsDb } from './opsdb.js';
import {
  normalizeLaunchdProgramArguments,
  RuntimePowerController,
  type RuntimePowerDriver,
  type RuntimePowerService,
} from './runtime-power.js';
import { getRuntimeDesiredState, setRuntimeDesiredState } from './runtime-state.js';

class FakePowerDriver implements RuntimePowerDriver {
  calls: string[] = [];
  repairLabels = new Set<string>();
  crashHostOnSleep = false;
  desiredStateAtFirstCall: string | undefined;
  wakePaused = false;
  onecli = { up: true, url: 'http://127.0.0.1:10254', local: true };
  host: RuntimePowerService = {
    label: 'com.nanoclaw-v2-test',
    plist: '/tmp/com.nanoclaw-v2-test.plist',
    pid: 101,
    loaded: true,
    running: true,
  };
  opsCenter: RuntimePowerService = {
    label: 'com.nanoclaw.opscenter-test',
    plist: '/tmp/com.nanoclaw.opscenter-test.plist',
    pid: 202,
    loaded: true,
    running: true,
  };
  docker = {
    daemonUp: true,
    containers: [{ id: 'c1', name: 'nanoclaw-v2-test', image: 'nanoclaw-agent:test', status: 'Up' }],
    imageSizeBytes: null,
  };

  constructor(private desired: () => string) {}

  private record(call: string): void {
    this.calls.push(call);
    this.desiredStateAtFirstCall ??= this.desired();
  }

  async hostService(): Promise<RuntimePowerService> {
    return { ...this.host };
  }
  async opsCenterService(): Promise<RuntimePowerService> {
    return { ...this.opsCenter };
  }
  async dockerStatus() {
    return { ...this.docker, containers: [...this.docker.containers] };
  }
  async onecliStatus() {
    return { ...this.onecli };
  }
  async ensureServiceExecutable(service: RuntimePowerService): Promise<boolean> {
    if (!service.label || !this.repairLabels.has(service.label)) return false;
    this.record(`repair:${service.label}`);
    return true;
  }
  async enableService(label: string): Promise<void> {
    this.record(`enable:${label}`);
  }
  async disableService(label: string): Promise<void> {
    this.record(`disable:${label}`);
  }
  async bootstrapService(plist: string): Promise<void> {
    this.record(`bootstrap:${plist}`);
    if (plist === this.host.plist) this.host = { ...this.host, loaded: true, running: true, pid: 303 };
    if (plist === this.opsCenter.plist) this.opsCenter = { ...this.opsCenter, loaded: true, running: true, pid: 404 };
  }
  async bootoutService(label: string): Promise<void> {
    this.record(`bootout:${label}`);
    if (label === this.host.label) {
      this.host = { ...this.host, loaded: false, running: false, pid: null };
      this.docker.containers = [];
    }
    if (label === this.opsCenter.label)
      this.opsCenter = { ...this.opsCenter, loaded: false, running: false, pid: null };
  }
  async kickstartService(label: string): Promise<void> {
    this.record(`kickstart:${label}`);
    if (label === this.host.label) this.host = { ...this.host, loaded: true, running: true, pid: 505 };
  }
  async startDockerDesktop(): Promise<void> {
    this.record('docker:start');
    this.docker.daemonUp = true;
  }
  async stopDockerDesktop(): Promise<void> {
    this.record('docker:stop');
    this.docker.daemonUp = false;
    this.docker.containers = [];
    this.onecli.up = false;
  }
  async stopManagedContainers(): Promise<void> {
    this.record('containers:stop');
    this.docker.containers = [];
  }
  async startOnecliGateway(): Promise<void> {
    this.record('onecli:start');
    this.onecli.up = true;
  }
  async pauseWakeCycler(): Promise<void> {
    this.record('wake:pause');
    this.wakePaused = true;
  }
  async wakeCyclerPaused(): Promise<boolean> {
    return this.wakePaused;
  }
  async sleep(): Promise<void> {
    if (this.crashHostOnSleep && this.host.running) {
      this.host = { ...this.host, running: false, pid: null };
    }
  }
}

describe('RuntimePowerController', () => {
  it('replaces a stale launchd Node executable without retaining a duplicate leading Node argument', () => {
    expect(
      normalizeLaunchdProgramArguments(
        ['/supported/bin/node', '/broken/bin/node', '/repo/dist/index.js'],
        '/supported/bin/node',
      ),
    ).toEqual(['/supported/bin/node', '/repo/dist/index.js']);
    expect(
      normalizeLaunchdProgramArguments(['/removed/bin/node', '/repo/dist/index.js'], '/supported/bin/node'),
    ).toEqual(['/supported/bin/node', '/repo/dist/index.js']);
  });

  it('persists stopped intent before pausing wakes, disabling launchd, and stopping Docker', async () => {
    const db = openOpsDb(':memory:');
    const driver = new FakePowerDriver(() => getRuntimeDesiredState(db));
    const power = new RuntimePowerController(db, driver, { timeoutMs: 50, pollMs: 1 });

    const result = await power.stopRuntime();

    expect(result.ok).toBe(true);
    expect(driver.desiredStateAtFirstCall).toBe('stopped');
    expect(getRuntimeDesiredState(db)).toBe('stopped');
    expect(driver.calls).toEqual([
      'wake:pause',
      'disable:com.nanoclaw-v2-test',
      'bootout:com.nanoclaw-v2-test',
      'containers:stop',
      'docker:stop',
    ]);
    expect((await power.snapshot()).runtimeStopped).toBe(true);
    db.close();
  });

  it('starts Docker and recovers OneCLI before bootstrapping the host, without silently resuming wake cycling', async () => {
    const db = openOpsDb(':memory:');
    setRuntimeDesiredState(db, 'stopped');
    const driver = new FakePowerDriver(() => getRuntimeDesiredState(db));
    driver.host = { ...driver.host, loaded: false, running: false, pid: null };
    driver.docker.daemonUp = false;
    driver.docker.containers = [];
    driver.onecli.up = false;
    driver.wakePaused = true;
    const power = new RuntimePowerController(db, driver, { timeoutMs: 50, pollMs: 1 });

    const result = await power.startRuntime();

    expect(result.ok).toBe(true);
    expect(driver.desiredStateAtFirstCall).toBe('running');
    expect(driver.calls).toEqual([
      'docker:start',
      'onecli:start',
      'enable:com.nanoclaw-v2-test',
      'bootstrap:/tmp/com.nanoclaw-v2-test.plist',
    ]);
    expect(driver.wakePaused).toBe(true);
    expect((await power.snapshot()).runtimeRunning).toBe(true);
    db.close();
  });

  it('reboots launchd from a repaired plist when its persisted Node executable is stale', async () => {
    const db = openOpsDb(':memory:');
    setRuntimeDesiredState(db, 'stopped');
    const driver = new FakePowerDriver(() => getRuntimeDesiredState(db));
    driver.host = { ...driver.host, running: false, pid: null };
    driver.repairLabels.add(driver.host.label!);
    const power = new RuntimePowerController(db, driver, { timeoutMs: 50, pollMs: 1 });

    const result = await power.startRuntime();

    expect(result.ok).toBe(true);
    expect(driver.calls).toEqual([
      'repair:com.nanoclaw-v2-test',
      'enable:com.nanoclaw-v2-test',
      'bootout:com.nanoclaw-v2-test',
      'bootstrap:/tmp/com.nanoclaw-v2-test.plist',
    ]);
    db.close();
  });

  it('does not report startup success when launchd only runs transiently and then crashes', async () => {
    const db = openOpsDb(':memory:');
    setRuntimeDesiredState(db, 'stopped');
    const driver = new FakePowerDriver(() => getRuntimeDesiredState(db));
    driver.host = { ...driver.host, loaded: false, running: false, pid: null };
    driver.crashHostOnSleep = true;
    const power = new RuntimePowerController(db, driver, { timeoutMs: 10, pollMs: 1 });

    const result = await power.startRuntime();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('NanoClaw host');
    db.close();
  });

  it('does not start the host when a remote OneCLI dependency is unavailable', async () => {
    const db = openOpsDb(':memory:');
    setRuntimeDesiredState(db, 'stopped');
    const driver = new FakePowerDriver(() => getRuntimeDesiredState(db));
    driver.host = { ...driver.host, loaded: false, running: false, pid: null };
    driver.onecli = { up: false, url: 'https://vault.example.test', local: false };
    const power = new RuntimePowerController(db, driver, { timeoutMs: 10, pollMs: 1 });

    const result = await power.startRuntime();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('remote OneCLI gateway');
    expect(driver.calls).not.toContain('enable:com.nanoclaw-v2-test');
    db.close();
  });

  it('hard-off disables Ops Center last, then lets the caller boot it out after responding', async () => {
    const db = openOpsDb(':memory:');
    const driver = new FakePowerDriver(() => getRuntimeDesiredState(db));
    const power = new RuntimePowerController(db, driver, { timeoutMs: 50, pollMs: 1 });

    const prepared = await power.prepareHardOff();

    expect(prepared.ok).toBe(true);
    expect(driver.calls.at(-1)).toBe('disable:com.nanoclaw.opscenter-test');
    expect(driver.opsCenter.running).toBe(true);
    await power.stopOpsCenter();
    expect(driver.calls.at(-1)).toBe('bootout:com.nanoclaw.opscenter-test');
    expect(driver.opsCenter.running).toBe(false);
    db.close();
  });

  it('can recover from hard-off by starting the runtime and Ops Center from the host CLI', async () => {
    const db = openOpsDb(':memory:');
    setRuntimeDesiredState(db, 'stopped');
    const driver = new FakePowerDriver(() => getRuntimeDesiredState(db));
    driver.host = { ...driver.host, loaded: false, running: false, pid: null };
    driver.opsCenter = { ...driver.opsCenter, loaded: false, running: false, pid: null };
    driver.docker.daemonUp = false;
    driver.docker.containers = [];
    driver.onecli.up = false;
    const power = new RuntimePowerController(db, driver, { timeoutMs: 50, pollMs: 1 });

    const result = await power.startRuntime({ includeOpsCenter: true });

    expect(result.ok).toBe(true);
    expect(driver.calls).toEqual([
      'docker:start',
      'onecli:start',
      'enable:com.nanoclaw-v2-test',
      'bootstrap:/tmp/com.nanoclaw-v2-test.plist',
      'enable:com.nanoclaw.opscenter-test',
      'bootstrap:/tmp/com.nanoclaw.opscenter-test.plist',
    ]);
    expect(driver.opsCenter.running).toBe(true);
    db.close();
  });
});
