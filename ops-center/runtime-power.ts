import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import type Database from 'better-sqlite3';

import { CONTAINER_INSTALL_LABEL, PATHS } from './config.js';
import {
  detectHostService,
  detectOpsCenterService,
  dockerStatus,
  onecliStatus,
  type DockerStatus,
  type HostService,
  type OneCliStatus,
} from './readers/system.js';
import { getRuntimeDesiredState, setRuntimeDesiredState, type RuntimeDesiredState } from './runtime-state.js';

const exec = promisify(execFile);

export type RuntimePowerService = HostService;

export interface RuntimePowerDriver {
  hostService(): Promise<RuntimePowerService>;
  opsCenterService(): Promise<RuntimePowerService>;
  dockerStatus(): Promise<DockerStatus>;
  onecliStatus(): Promise<OneCliStatus>;
  ensureServiceExecutable(service: RuntimePowerService): Promise<boolean>;
  enableService(label: string): Promise<void>;
  disableService(label: string): Promise<void>;
  bootstrapService(plist: string): Promise<void>;
  bootoutService(label: string): Promise<void>;
  kickstartService(label: string): Promise<void>;
  startDockerDesktop(): Promise<void>;
  stopDockerDesktop(): Promise<void>;
  stopManagedContainers(): Promise<void>;
  startOnecliGateway(): Promise<void>;
  pauseWakeCycler(): Promise<void>;
  wakeCyclerPaused(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface RuntimePowerSnapshot {
  desiredState: RuntimeDesiredState;
  host: RuntimePowerService;
  opsCenter: RuntimePowerService;
  docker: DockerStatus;
  onecli: OneCliStatus;
  wakeCyclerPaused: boolean;
  runtimeRunning: boolean;
  runtimeStopped: boolean;
}

export interface RuntimePowerResult {
  ok: boolean;
  message: string;
}

function launchdTarget(label: string): string {
  return `gui/${process.getuid?.() ?? 501}/${label}`;
}

export function normalizeLaunchdProgramArguments(args: string[], nodeExecutable: string): string[] {
  if (args.length === 0) throw new Error('Launchd ProgramArguments is empty');
  const remaining = args.slice(1);
  while (remaining.length > 0 && path.basename(remaining[0]) === 'node') remaining.shift();
  return [nodeExecutable, ...remaining];
}

export function createRuntimePowerDriver(): RuntimePowerDriver {
  const runLaunchctl = async (verb: string, value: string): Promise<void> => {
    await exec('launchctl', [verb, value], { timeout: 30_000 });
  };
  return {
    hostService: detectHostService,
    opsCenterService: detectOpsCenterService,
    dockerStatus,
    onecliStatus,
    ensureServiceExecutable: async (service) => {
      if (process.platform !== 'darwin' || !service.plist || !fs.existsSync(service.plist)) return false;
      const { stdout } = await exec(
        'plutil',
        ['-extract', 'ProgramArguments', 'json', '-o', '-', service.plist],
        { timeout: 10_000 },
      );
      const configuredArguments = JSON.parse(stdout) as unknown;
      if (
        !Array.isArray(configuredArguments) ||
        configuredArguments.length === 0 ||
        !configuredArguments.every((value) => typeof value === 'string')
      ) {
        throw new Error(`Invalid ProgramArguments in ${service.plist}`);
      }
      const configuredExecutable = configuredArguments[0];
      const duplicateLeadingNode =
        configuredArguments.length > 1 && path.basename(configuredArguments[1]) === 'node';
      try {
        fs.accessSync(configuredExecutable, fs.constants.X_OK);
        if (!duplicateLeadingNode) return false;
      } catch {
        // Node managers can remove an install while leaving a launchd plist
        // and symlink behind. Repair only the executable field; every other
        // service setting remains untouched.
      }
      const repairedArguments = normalizeLaunchdProgramArguments(configuredArguments, process.execPath);
      await exec(
        'plutil',
        ['-replace', 'ProgramArguments', '-json', JSON.stringify(repairedArguments), service.plist],
        { timeout: 10_000 },
      );
      return true;
    },
    enableService: (label) => runLaunchctl('enable', launchdTarget(label)),
    disableService: (label) => runLaunchctl('disable', launchdTarget(label)),
    bootstrapService: async (plist) => {
      await exec('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, plist], { timeout: 30_000 });
    },
    bootoutService: (label) => runLaunchctl('bootout', launchdTarget(label)),
    kickstartService: (label) => runLaunchctl('kickstart', launchdTarget(label)),
    startDockerDesktop: async () => {
      // `docker desktop start` can keep its CLI process attached forever on
      // macOS even after it launches com.docker.backend. Launch the app
      // non-blockingly and let waitFor() own the bounded daemon-readiness poll.
      await exec('open', ['-gja', 'Docker'], { timeout: 10_000 });
    },
    stopDockerDesktop: async () => {
      await exec('docker', ['desktop', 'stop'], { timeout: 120_000 });
    },
    stopManagedContainers: async () => {
      const { stdout } = await exec(
        'docker',
        ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--format', '{{.Names}}'],
        { timeout: 10_000 },
      );
      const names = stdout
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean);
      await Promise.all(names.map((name) => exec('docker', ['stop', '-t', '1', name], { timeout: 15_000 })));
    },
    startOnecliGateway: async () => {
      const composeDir = path.join(process.env.HOME || '', '.onecli');
      const composeFile = path.join(composeDir, 'docker-compose.yml');
      if (!process.env.HOME || !fs.existsSync(composeFile)) {
        throw new Error(`Local OneCLI compose file not found at ${composeFile}`);
      }
      await exec(
        'docker',
        ['compose', '--project-directory', composeDir, '-f', composeFile, 'up', '-d', '--pull', 'never'],
        { timeout: 120_000 },
      );
    },
    pauseWakeCycler: async () => {
      fs.mkdirSync(path.dirname(PATHS.wakeCyclerDisabled), { recursive: true });
      fs.closeSync(fs.openSync(PATHS.wakeCyclerDisabled, 'a'));
    },
    wakeCyclerPaused: async () => fs.existsSync(PATHS.wakeCyclerDisabled),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export class RuntimePowerController {
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private hardOffOpsCenterLabel: string | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly driver: RuntimePowerDriver = createRuntimePowerDriver(),
    options: { timeoutMs?: number; pollMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.pollMs = options.pollMs ?? 500;
  }

  async snapshot(): Promise<RuntimePowerSnapshot> {
    const [host, opsCenter, docker, onecli, wakeCyclerPaused] = await Promise.all([
      this.driver.hostService(),
      this.driver.opsCenterService(),
      this.driver.dockerStatus(),
      this.driver.onecliStatus(),
      this.driver.wakeCyclerPaused(),
    ]);
    const desiredState = getRuntimeDesiredState(this.db);
    return {
      desiredState,
      host,
      opsCenter,
      docker,
      onecli,
      wakeCyclerPaused,
      runtimeRunning: desiredState === 'running' && host.running && docker.daemonUp && onecli.up,
      runtimeStopped: desiredState === 'stopped' && !host.running && docker.containers.length === 0 && !docker.daemonUp,
    };
  }

  private async waitFor(label: string, predicate: (snapshot: RuntimePowerSnapshot) => boolean): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    let latest = await this.snapshot();
    while (!predicate(latest) && Date.now() < deadline) {
      await this.driver.sleep(this.pollMs);
      latest = await this.snapshot();
    }
    if (!predicate(latest)) throw new Error(`Timed out waiting for ${label}`);
  }

  private async waitForStable(
    label: string,
    predicate: (snapshot: RuntimePowerSnapshot) => boolean,
    requiredPolls = 3,
  ): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    let consecutive = 0;
    while (Date.now() < deadline) {
      const latest = await this.snapshot();
      consecutive = predicate(latest) ? consecutive + 1 : 0;
      if (consecutive >= requiredPolls) return;
      await this.driver.sleep(this.pollMs);
    }
    throw new Error(`Timed out waiting for stable ${label}`);
  }

  private async startService(service: RuntimePowerService, name: string): Promise<void> {
    if (!service.label || !service.plist) throw new Error(`No ${name} launchd plist found`);
    const repairedExecutable = await this.driver.ensureServiceExecutable(service);
    await this.driver.enableService(service.label);
    if (repairedExecutable) {
      if (service.loaded) await this.driver.bootoutService(service.label);
      await this.driver.bootstrapService(service.plist);
    } else if (!service.loaded) await this.driver.bootstrapService(service.plist);
    else if (!service.running) await this.driver.kickstartService(service.label);
  }

  async stopRuntime(): Promise<RuntimePowerResult> {
    // Persist intent first: the concurrently running watchdog must see stopped
    // before any component begins to disappear.
    setRuntimeDesiredState(this.db, 'stopped');
    try {
      await this.driver.pauseWakeCycler();
      const host = await this.driver.hostService();
      if (host.label) await this.driver.disableService(host.label);
      if (host.loaded && host.label) await this.driver.bootoutService(host.label);
      // launchd stops the host process, but its `docker run` children can
      // outlive it. Reap only this checkout's label-scoped containers before
      // asking Docker Desktop to exit.
      await this.driver.stopManagedContainers();
      await this.waitFor(
        'the NanoClaw host and its containers to stop',
        (snapshot) => !snapshot.host.running && snapshot.docker.containers.length === 0,
      );
      const docker = await this.driver.dockerStatus();
      if (docker.daemonUp) await this.driver.stopDockerDesktop();
      await this.waitFor('Docker Desktop to stop', (snapshot) => !snapshot.docker.daemonUp);
      return {
        ok: true,
        message: 'Runtime stopped: host disabled, NanoClaw containers gone, Docker Desktop stopped, wake-cycler paused',
      };
    } catch (error) {
      return { ok: false, message: `Runtime stop incomplete: ${(error as Error).message}` };
    }
  }

  async startRuntime(options: { includeOpsCenter?: boolean } = {}): Promise<RuntimePowerResult> {
    // Deliberately do not resume the wake-cycler here. Power scheduling remains
    // an independent, explicit operator choice after a shutdown.
    setRuntimeDesiredState(this.db, 'running');
    try {
      if (!(await this.driver.dockerStatus()).daemonUp) await this.driver.startDockerDesktop();
      await this.waitFor('Docker Desktop to start', (snapshot) => snapshot.docker.daemonUp);
      const gateway = await this.driver.onecliStatus();
      if (!gateway.up) {
        if (!gateway.local) {
          throw new Error(`Configured remote OneCLI gateway ${gateway.url} is unreachable; start it externally`);
        }
        await this.driver.startOnecliGateway();
        await this.waitFor('the OneCLI credential gateway to start', (snapshot) => snapshot.onecli.up);
      }
      await this.startService(await this.driver.hostService(), 'NanoClaw host');
      await this.waitForStable('NanoClaw host startup', (snapshot) => snapshot.host.running);
      if (options.includeOpsCenter) {
        await this.startService(await this.driver.opsCenterService(), 'Ops Center');
        await this.waitForStable('Ops Center startup', (snapshot) => snapshot.opsCenter.running);
      }
      return {
        ok: true,
        message: `Runtime started${options.includeOpsCenter ? ' with Ops Center' : ''}; wake-cycler remains paused`,
      };
    } catch (error) {
      return { ok: false, message: `Runtime start incomplete: ${(error as Error).message}` };
    }
  }

  async prepareHardOff(): Promise<RuntimePowerResult> {
    const stopped = await this.stopRuntime();
    if (!stopped.ok) return stopped;
    try {
      const opsCenter = await this.driver.opsCenterService();
      if (!opsCenter.label) throw new Error('No Ops Center launchd service found');
      await this.driver.disableService(opsCenter.label);
      this.hardOffOpsCenterLabel = opsCenter.label;
      return {
        ok: true,
        message: 'Hard-off prepared: runtime stopped and Ops Center disabled; dashboard is shutting down',
      };
    } catch (error) {
      return { ok: false, message: `Hard-off incomplete: ${(error as Error).message}` };
    }
  }

  /** Called after the hard-off HTTP response has been flushed, or directly by the host CLI. */
  async stopOpsCenter(): Promise<void> {
    const service = await this.driver.opsCenterService();
    const label = this.hardOffOpsCenterLabel ?? service.label;
    if (label && service.loaded) await this.driver.bootoutService(label);
  }
}
