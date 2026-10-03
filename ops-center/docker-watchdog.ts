/**
 * Docker watchdog for Ops Center.
 *
 * The NanoClaw host hard-requires a container runtime: at startup it runs
 * `docker info` and, if Docker is down, prints a FATAL and exits — which under
 * launchd becomes a crash-loop (with circuit-breaker backoff). Nothing in the
 * host ever tries to *start* Docker, and Docker isn't a login item, so after a
 * reboot or a Docker quit the host can't recover on its own.
 *
 * Ops Center runs as a separate launchd agent with no Docker dependency, so it
 * stays up exactly when the host is failing. That makes it the right place to
 * keep Docker alive: on each tick, if Docker is down, launch Docker Desktop in
 * the background. Once the daemon is back, the host's next startup attempt
 * succeeds and the channels (WhatsApp, etc.) reconnect.
 *
 * Idempotent: a no-op when Docker is already up. The relaunch is rate-limited so
 * we don't spawn `open` every tick during the ~30-60s Docker takes to boot.
 */
import { execSync } from 'child_process';

import { addEvent } from './opsdb.js';
import { getRuntimeDesiredState } from './runtime-state.js';

// Derive the db handle type from addEvent so we don't import better-sqlite3 just
// for a type annotation.
type OpsDbHandle = Parameters<typeof addEvent>[0];

export type DockerStatus = 'up' | 'launching' | 'cooldown' | 'failed' | 'suppressed';

/** Seam for tests — the real implementation shells out to docker / open. */
export interface DockerControl {
  /** True if the Docker daemon is reachable. */
  isUp(): boolean;
  /** Launch Docker Desktop (background, no focus steal). Throws on failure. */
  launch(): void;
}

const CHECK_TIMEOUT_MS = 10_000;
// Docker Desktop needs ~30-60s to bring the daemon up after launch; don't fire
// another `open` until at least this long has passed since the last attempt.
export const RELAUNCH_COOLDOWN_MS = 90_000;

export const realDockerControl: DockerControl = {
  isUp() {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: CHECK_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  },
  launch() {
    // -g: launch in the background, don't steal focus. `open` exits as soon as
    // the app is launched; the daemon comes up asynchronously over ~30-60s.
    execSync('open -g -a Docker', { stdio: 'pipe', timeout: CHECK_TIMEOUT_MS });
  },
};

/**
 * Create a Docker watchdog. The returned function is safe to call at startup and
 * on every tick. Relaunch-cooldown state lives in a closure so each instance is
 * independent (and tests get a clean slate). `now` is injectable for tests.
 */
export function createDockerWatchdog(control: DockerControl = realDockerControl) {
  // -Infinity = "never launched / cooldown elapsed" so the first outage launches
  // immediately. (Plain 0 would treat t=0 as a launch and wrongly report a
  // cooldown for any now < RELAUNCH_COOLDOWN_MS.)
  let lastLaunchMs = Number.NEGATIVE_INFINITY;
  return function ensureDocker(db: OpsDbHandle, now: number = Date.now()): DockerStatus {
    if (getRuntimeDesiredState(db) === 'stopped') return 'suppressed';
    if (control.isUp()) {
      // recovered — reset so a future outage relaunches immediately
      lastLaunchMs = Number.NEGATIVE_INFINITY;
      return 'up';
    }
    if (now - lastLaunchMs < RELAUNCH_COOLDOWN_MS) {
      return 'cooldown'; // launched recently; give Docker time to finish booting
    }
    lastLaunchMs = now;
    try {
      control.launch();
      addEvent(db, {
        ts: new Date(now).toISOString(),
        group_id: 'host',
        kind: 'docker_autostart',
        severity: 'warn',
        detail: 'Docker runtime was down; launched Docker Desktop. Host recovers on its next startup attempt.',
      });
      console.error('[ops-center] Docker was down — launched Docker Desktop');
      return 'launching';
    } catch (e) {
      addEvent(db, {
        ts: new Date(now).toISOString(),
        group_id: 'host',
        kind: 'docker_autostart_failed',
        severity: 'error',
        detail: `Failed to launch Docker Desktop: ${e instanceof Error ? e.message : String(e)}`,
      });
      console.error('[ops-center] failed to launch Docker:', e);
      return 'failed';
    }
  };
}
