/**
 * System probes: launchd service state, docker, disk usage.
 * All read-only; results cached briefly so the fast lane stays cheap.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { CONTAINER_INSTALL_LABEL, PATHS, ROOT, readEnvKey } from '../config.js';

const exec = promisify(execFile);

export interface HostService {
  label: string | null;
  plist: string | null;
  pid: number | null;
  loaded: boolean;
  running: boolean;
}

/**
 * Find the NanoClaw launchd service. The label is install-specific
 * (this install: com.nanoclaw-v2-<hash>), so detect rather than hardcode.
 */
export async function detectHostService(): Promise<HostService> {
  const result: HostService = { label: null, plist: null, pid: null, loaded: false, running: false };
  // Find candidate plists pointing at this repo
  const laDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  if (fs.existsSync(laDir)) {
    for (const f of fs.readdirSync(laDir)) {
      if (!f.includes('nanoclaw') || !f.endsWith('.plist') || f.includes('statusbar') || f.includes('opscenter'))
        continue;
      const p = path.join(laDir, f);
      const text = fs.readFileSync(p, 'utf8');
      if (!text.includes(ROOT)) continue;
      const label = text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? f.replace('.plist', '');
      result.label = label;
      result.plist = p;
      break;
    }
  }
  if (!result.label) return result;
  try {
    const { stdout } = await exec('launchctl', ['list']);
    for (const line of stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols[2] === result.label) {
        result.loaded = true;
        result.pid = cols[0] === '-' ? null : Number(cols[0]);
        result.running = result.pid != null;
      }
    }
  } catch {
    /* launchctl unavailable */
  }
  return result;
}

/** Find the install's Ops Center launchd service, including the legacy unslugged label. */
export async function detectOpsCenterService(): Promise<HostService> {
  const result: HostService = { label: null, plist: null, pid: null, loaded: false, running: false };
  const laDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  if (fs.existsSync(laDir)) {
    const preferredLabel = `com.nanoclaw.opscenter-${createHash('sha1').update(ROOT).digest('hex').slice(0, 8)}`;
    const files = fs
      .readdirSync(laDir)
      .sort((a, b) => Number(b.startsWith(preferredLabel)) - Number(a.startsWith(preferredLabel)));
    for (const f of files) {
      if (!f.includes('nanoclaw') || !f.includes('opscenter') || !f.endsWith('.plist')) continue;
      const p = path.join(laDir, f);
      const text = fs.readFileSync(p, 'utf8');
      if (!text.includes(ROOT) || !text.includes('ops-center')) continue;
      result.label = text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? f.replace('.plist', '');
      result.plist = p;
      break;
    }
  }
  // A launchd-provided label is authoritative for a running legacy service.
  if (process.env.XPC_SERVICE_NAME?.includes('nanoclaw') && process.env.XPC_SERVICE_NAME.includes('opscenter')) {
    result.label = process.env.XPC_SERVICE_NAME;
  }
  if (!result.label) return result;
  try {
    const { stdout } = await exec('launchctl', ['list']);
    for (const line of stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols[2] === result.label) {
        result.loaded = true;
        result.pid = cols[0] === '-' ? null : Number(cols[0]);
        result.running = result.pid != null;
      }
    }
  } catch {
    /* launchctl unavailable */
  }
  return result;
}

export interface DockerStatus {
  daemonUp: boolean;
  containers: { id: string; name: string; image: string; status: string }[];
  imageSizeBytes: number | null;
}

export async function dockerStatus(): Promise<DockerStatus> {
  const out: DockerStatus = { daemonUp: false, containers: [], imageSizeBytes: null };
  try {
    const { stdout } = await exec(
      'docker',
      ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--format', '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}'],
      { timeout: 5000 },
    );
    out.daemonUp = true;
    for (const line of stdout.split('\n').filter(Boolean)) {
      const [id, name, image, status] = line.split('|');
      if (image?.includes('nanoclaw') || name?.includes('nanoclaw')) out.containers.push({ id, name, image, status });
    }
    const { stdout: img } = await exec(
      'docker',
      ['image', 'inspect', 'nanoclaw-agent:latest', '--format', '{{.Size}}'],
      {
        timeout: 5000,
      },
    );
    out.imageSizeBytes = Number(img.trim()) || null;
  } catch {
    /* daemon down or image missing */
  }
  return out;
}

export function dirSizeBytes(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else total += fs.statSync(p).size;
      } catch {
        /* race with deletion */
      }
    }
  }
  return total;
}

export interface DiskUsage {
  sessions: number;
  logs: number;
  backups: number;
  opsDb: number;
  centralDb: number;
  dockerImage: number | null;
}

export async function diskUsage(): Promise<DiskUsage> {
  const docker = await dockerStatus();
  return {
    sessions: dirSizeBytes(PATHS.sessionsDir),
    logs: dirSizeBytes(PATHS.logsDir),
    backups: dirSizeBytes(PATHS.backupsDir),
    opsDb: fs.existsSync(PATHS.opsDb) ? fs.statSync(PATHS.opsDb).size : 0,
    centralDb: fs.existsSync(PATHS.centralDb) ? fs.statSync(PATHS.centralDb).size : 0,
    dockerImage: docker.imageSizeBytes,
  };
}

export interface OneCliStatus {
  up: boolean;
  url: string;
  local: boolean;
}

function configuredOnecliUrl(): string {
  return readEnvKey('ONECLI_URL') || 'http://127.0.0.1:10254';
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

/** OneCLI gateway health at the configured local or remote API URL. */
export async function onecliStatus(): Promise<OneCliStatus> {
  const url = configuredOnecliUrl();
  const local = isLoopbackUrl(url);
  try {
    const base = url.endsWith('/') ? url : `${url}/`;
    const res = await fetch(new URL('v1/health', base), { signal: AbortSignal.timeout(2000) });
    return { up: res.ok, url, local };
  } catch {
    return { up: false, url, local };
  }
}

/** Strip ANSI color codes (host logs are colored). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

/** Channel adapter liveness, inferred from recent host log lines + process state. */
export function channelLiveness(channels: string[], recentLog: string[]): Record<string, boolean> {
  // Heuristic: an adapter that logged 'Channel adapter started channel=<x>' since
  // the last host start and has no later 'adapter stopped/disconnected' line is live.
  const live: Record<string, boolean> = {};
  for (const ch of channels) live[ch] = false;
  for (const raw of recentLog) {
    const line = stripAnsi(raw);
    const started = line.match(/Channel adapter started.*channel="?([\w-]+)"?/);
    if (started && started[1] in live) live[started[1]] = true;
    const stopped = line.match(/adapter (?:stopped|disconnected).*channel="?([\w-]+)"?/i);
    if (stopped && stopped[1] in live) live[stopped[1]] = false;
  }
  return live;
}
