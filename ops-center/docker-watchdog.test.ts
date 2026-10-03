import { describe, it, expect } from 'vitest';

import { createDockerWatchdog, RELAUNCH_COOLDOWN_MS, type DockerControl } from './docker-watchdog.js';
import { openOpsDb } from './opsdb.js';
import { setRuntimeDesiredState } from './runtime-state.js';

/** Controllable fake so tests never touch real docker / open. */
class FakeDocker implements DockerControl {
  up = true;
  launches = 0;
  throwOnLaunch = false;
  isUp(): boolean {
    return this.up;
  }
  launch(): void {
    this.launches++;
    if (this.throwOnLaunch) throw new Error('open failed');
    // NOTE: deliberately does NOT flip `up` — Docker takes ~30-60s to boot, so
    // tests drive `up` explicitly to model the daemon coming online later.
  }
}

function events(db: ReturnType<typeof openOpsDb>): { kind: string; severity: string }[] {
  return db.prepare('SELECT kind, severity FROM events ORDER BY rowid').all() as {
    kind: string;
    severity: string;
  }[];
}

describe('docker watchdog', () => {
  it('does not relaunch Docker while the operator-requested state is stopped', () => {
    const db = openOpsDb(':memory:');
    const d = new FakeDocker();
    d.up = false;
    setRuntimeDesiredState(db, 'stopped');
    const ensure = createDockerWatchdog(d);
    expect(ensure(db, 1000)).toBe('suppressed');
    expect(d.launches).toBe(0);
    expect(events(db)).toHaveLength(0);
    db.close();
  });

  it('no-ops when Docker is already up', () => {
    const db = openOpsDb(':memory:');
    const d = new FakeDocker();
    d.up = true;
    const ensure = createDockerWatchdog(d);
    expect(ensure(db, 1000)).toBe('up');
    expect(d.launches).toBe(0);
    expect(events(db)).toHaveLength(0);
    db.close();
  });

  it('launches Docker and records a warn event when it is down', () => {
    const db = openOpsDb(':memory:');
    const d = new FakeDocker();
    d.up = false;
    const ensure = createDockerWatchdog(d);
    expect(ensure(db, 1000)).toBe('launching');
    expect(d.launches).toBe(1);
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({ kind: 'docker_autostart', severity: 'warn' });
    db.close();
  });

  it('does not relaunch within the cooldown window', () => {
    const db = openOpsDb(':memory:');
    const d = new FakeDocker();
    d.up = false;
    const ensure = createDockerWatchdog(d);
    expect(ensure(db, 1000)).toBe('launching');
    expect(ensure(db, 1000 + RELAUNCH_COOLDOWN_MS - 1)).toBe('cooldown');
    expect(d.launches).toBe(1); // still just the one launch
    db.close();
  });

  it('relaunches once the cooldown elapses', () => {
    const db = openOpsDb(':memory:');
    const d = new FakeDocker();
    d.up = false;
    const ensure = createDockerWatchdog(d);
    ensure(db, 1000);
    expect(ensure(db, 1000 + RELAUNCH_COOLDOWN_MS)).toBe('launching');
    expect(d.launches).toBe(2);
    db.close();
  });

  it('resets the cooldown once Docker recovers (immediate relaunch on next outage)', () => {
    const db = openOpsDb(':memory:');
    const d = new FakeDocker();
    d.up = false;
    const ensure = createDockerWatchdog(d);
    ensure(db, 1000); // launch #1
    d.up = true;
    expect(ensure(db, 1500)).toBe('up'); // recovered, cooldown reset
    d.up = false;
    expect(ensure(db, 1600)).toBe('launching'); // relaunch despite < cooldown since launch #1
    expect(d.launches).toBe(2);
    db.close();
  });

  it('reports failure and records an error event when launch throws', () => {
    const db = openOpsDb(':memory:');
    const d = new FakeDocker();
    d.up = false;
    d.throwOnLaunch = true;
    const ensure = createDockerWatchdog(d);
    expect(ensure(db, 1000)).toBe('failed');
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({ kind: 'docker_autostart_failed', severity: 'error' });
    db.close();
  });
});
