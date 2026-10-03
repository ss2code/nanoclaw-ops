/**
 * Machine / system status probe for the Ops Center "System" panel.
 *
 * Design constraints (from the panel requirement):
 *  - READ-ONLY. Every probe only observes; nothing here mutates host state.
 *  - STRICT TIMEOUTS + BOUNDED OUTPUT. Each subprocess gets an explicit timeout
 *    and a small maxBuffer; parsed output is sliced. A resource-constrained host
 *    must never be held up by a wedged probe, so a
 *    wedged probe must never hang the endpoint or spew unbounded text.
 *  - REDACT credentials / environment variables. We never read process.env or
 *    dump raw command output into the payload; only structured fields are
 *    extracted, and every free-text field is passed through {@link redactSecrets}.
 *  - GRACEFUL DEGRADATION. A missing tool (ENOENT), a timeout, or a parse failure
 *    yields a null/"unavailable" field plus a short entry in `probeErrors` — it
 *    never throws out of {@link machineStatus}.
 *  - DEPENDENCY-INJECTED. `exec`, `now`, the listener info, and the underlying
 *    system probes are all injectable so tests can simulate unavailable tools,
 *    timeouts, redaction, and the tunnel/server distinction without touching the
 *    real host.
 *
 * The cheap host vitals (hostname, arch, uptime, load, RAM) come from the in-process
 * `os` module. The optional top-process and pressure probes are separately bounded
 * and run only through the cached System-status path.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';
import type { MissionHealth } from '../opsdb.js';
import {
  detectHostService,
  detectOpsCenterService,
  diskUsage,
  dockerStatus,
  onecliStatus,
  type DiskUsage,
  type DockerStatus,
  type HostService,
  type OneCliStatus,
} from './system.js';
import {
  classifyTunnel,
  getLastClientContactMs,
  type TunnelServerView,
  type TunnelThresholds,
} from './tunnel-heartbeat.js';

const execFileP = promisify(execFile);

/** Subset of `promisify(execFile)` we depend on — injectable for tests. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_TIMEOUT_MS = 3000;
/** `docker stats` is the heaviest probe on Docker Desktop; give it a tighter leash. */
const DEFAULT_DOCKER_STATS_TIMEOUT_MS = 4000;
const MAX_BUFFER = 256 * 1024;

// --------------------------------------------------------------------------
// Redaction
// --------------------------------------------------------------------------

/** Opaque-token shapes we blank wholesale wherever they appear. */
const SECRET_TOKEN_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk|sk-ant|rk_live|rk_test)-[A-Za-z0-9_-]{12,}/g, // OpenAI / Anthropic style
  /\bghp_[A-Za-z0-9]{16,}/g, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{10,}=*/g, // Authorization: Bearer ...
];

/** `KEY=value` / `KEY: value` where KEY looks credential-ish. */
const SECRET_KV = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|SESSION|COOKIE|APIKEY)[A-Za-z0-9_]*)\s*[=:]\s*("?)([^\s"']+)\2/gi;

/**
 * Mask anything that looks like a credential or an environment-variable
 * assignment. Applied to every free-text field before it enters the payload, so
 * even an unexpected leak (a token embedded in a container name, an error message
 * carrying a URL with a key) is scrubbed. Conservative on structure, aggressive
 * on the values: we would rather blank a harmless blob than surface a secret.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  // Token shapes first: otherwise a header like "Authorization: Bearer <token>"
  // has its scheme word ("Bearer") swallowed by the KV rule as the "value" while
  // the actual token leaks past it. Masking the whole token shape up front closes
  // that gap; the KV pass then tidies any remaining KEY=value assignments.
  for (const re of SECRET_TOKEN_PATTERNS) out = out.replace(re, '***');
  out = out.replace(SECRET_KV, (_m, key: string) => `${key}=***`);
  // Long opaque hex / base64 blobs that survived the shaped patterns above.
  out = out.replace(/\b[A-Fa-f0-9]{32,}\b/g, '***');
  out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '***');
  return out;
}

// --------------------------------------------------------------------------
// Host vitals and low-cost pressure signals (all bounded/cached by the caller)
// --------------------------------------------------------------------------

export interface HostVitals {
  hostname: string;
  platform: string;
  arch: string;
  kernel: string;
  osName: string | null;
  osBuild: string | null;
  uptimeSec: number;
  cpu: {
    model: string | null;
    cores: number;
    loadAvg: [number, number, number];
    /** 1-min load as a percentage of core count (rounded); null if cores unknown. */
    loadPct: number | null;
    /** Highest recent process CPU sample from `ps`; null if unavailable. */
    topProcess: CpuProcess | null;
  };
  mem: MemUsage;
  memoryPressure: MemoryPressure | null;
}

export interface CpuProcess {
  pid: number;
  cpuPct: number;
  /** Basename only — never expose command arguments or full paths. */
  command: string;
}

export type PressureLevel = 'ok' | 'warn' | 'critical';

export interface MemoryPressure {
  /** macOS `memory_pressure` free percentage; null for other sources. */
  freePct: number | null;
  /** Reserved for Linux PSI support; null on macOS. */
  stallPct10: number | null;
  level: PressureLevel;
  source: 'memory_pressure' | 'psi';
}

export interface MemUsage {
  totalBytes: number;
  /** Reclaimable/available bytes (total − used). */
  freeBytes: number;
  usedBytes: number;
  usedPct: number;
  /** How the figure was derived — 'vm_stat' (honest on macOS) or 'os' (fallback). */
  source: 'vm_stat' | 'os';
}

/**
 * macOS version never changes for the life of the process, so probe `sw_vers`
 * once and cache. One subprocess, ever. Non-Darwin hosts skip it entirely.
 */
let cachedOsVersion: { name: string | null; build: string | null } | null = null;

/** Test-only: forget the cached `sw_vers` result. */
export function _resetOsVersionCache(): void {
  cachedOsVersion = null;
}

async function readMacOsVersion(
  exec: ExecFn,
  timeoutMs: number,
  platform: string,
): Promise<{ name: string | null; build: string | null }> {
  if (platform !== 'darwin') return { name: null, build: null };
  if (cachedOsVersion) return cachedOsVersion;
  const { stdout } = await exec('sw_vers', [], { timeout: timeoutMs, maxBuffer: 64 * 1024 });
  const product = stdout.match(/ProductName:\s*(.+)/)?.[1]?.trim();
  const version = stdout.match(/ProductVersion:\s*(.+)/)?.[1]?.trim();
  const build = stdout.match(/BuildVersion:\s*(.+)/)?.[1]?.trim();
  const name = version ? `${product || 'macOS'} ${version}` : product || null;
  cachedOsVersion = { name: name ?? null, build: build ?? null };
  return cachedOsVersion;
}

/** Free-memory fallback straight from the `os` module (accurate off macOS). */
function osMemUsage(): MemUsage {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
    source: 'os',
  };
}

/**
 * Compute macOS memory-in-use from `vm_stat`. `os.freemem()` on macOS counts only
 * wholly-free pages and ignores reclaimable cache, so it reports ~98% used on a
 * perfectly healthy Mac. This mirrors Activity Monitor's "Memory Used" — the sum
 * of active + wired + compressed pages — which is the honest figure. Returns null
 * if the output can't be parsed so the caller can fall back to the os module.
 */
export function parseVmStat(stdout: string, totalBytes: number): MemUsage | null {
  const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1]) || 4096;
  const pages = (label: string): number | null => {
    const m = stdout.match(new RegExp(`Pages ${label}:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const active = pages('active');
  const wired = pages('wired down');
  const compressed = pages('occupied by compressor');
  if (active == null || wired == null || compressed == null || totalBytes <= 0) return null;
  const usedBytes = Math.min(totalBytes, (active + wired + compressed) * pageSize);
  return {
    totalBytes,
    freeBytes: Math.max(0, totalBytes - usedBytes),
    usedBytes,
    usedPct: Math.round((usedBytes / totalBytes) * 100),
    source: 'vm_stat',
  };
}

async function readMemUsage(exec: ExecFn, platform: string, timeoutMs: number): Promise<MemUsage> {
  if (platform !== 'darwin') return osMemUsage();
  try {
    const { stdout } = await exec('vm_stat', [], { timeout: timeoutMs, maxBuffer: 64 * 1024 });
    return parseVmStat(stdout, os.totalmem()) ?? osMemUsage();
  } catch {
    return osMemUsage();
  }
}

function readHostVitals(
  osVersion: { name: string | null; build: string | null },
  mem: MemUsage,
  topProcess: CpuProcess | null,
  memoryPressure: MemoryPressure | null,
): HostVitals {
  const cpus = os.cpus?.() ?? [];
  const cores = cpus.length;
  const la = os.loadavg();
  const loadAvg: [number, number, number] = [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0];
  // Some restricted launch/sandbox contexts deny uv_uptime even though the
  // other os probes work. Keep one denied field from blanking the whole card.
  let uptimeSec = 0;
  try {
    uptimeSec = Math.round(os.uptime());
  } catch {
    /* unavailable */
  }
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    kernel: os.release(),
    osName: osVersion.name,
    osBuild: osVersion.build,
    uptimeSec,
    cpu: {
      model: cpus[0]?.model?.trim() || null,
      cores,
      loadAvg,
      loadPct: cores > 0 ? Math.round((loadAvg[0] / cores) * 100) : null,
      topProcess,
    },
    mem,
    memoryPressure,
  };
}

/** Parse `ps` output without carrying command arguments or unbounded labels. */
export function parsePsCpu(stdout: string): CpuProcess[] {
  const rows: CpuProcess[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const cpuPct = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isFinite(cpuPct) || cpuPct < 0) continue;
    const rawCommand = match[3].split('/').pop()?.trim() ?? '';
    const command = redactSecrets(rawCommand).slice(0, 80);
    if (!command) continue;
    rows.push({ pid, cpuPct, command });
  }
  return rows.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 3);
}

/** Parse macOS `memory_pressure -Q` output. */
export function parseMemoryPressure(stdout: string): MemoryPressure | null {
  const freePct = Number(stdout.match(/System-wide memory free percentage:\s*([\d.]+)%/i)?.[1]);
  if (!Number.isFinite(freePct) || freePct < 0 || freePct > 100) return null;
  return {
    freePct,
    stallPct10: null,
    level: freePct <= 5 ? 'critical' : freePct <= 20 ? 'warn' : 'ok',
    source: 'memory_pressure',
  };
}

async function readTopCpuProcess(
  exec: ExecFn,
  platform: string,
  timeoutMs: number,
  pushError: (msg: string) => void,
): Promise<CpuProcess | null> {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  try {
    const args = platform === 'darwin' ? ['-axo', 'pid=,pcpu=,comm='] : ['-eo', 'pid=,pcpu=,comm='];
    return parsePsCpu((await exec('ps', args, { timeout: timeoutMs, maxBuffer: 128 * 1024 })).stdout)[0] ?? null;
  } catch {
    pushError('ps cpu: unavailable');
    return null;
  }
}

async function readMemoryPressure(
  exec: ExecFn,
  platform: string,
  timeoutMs: number,
  pushError: (msg: string) => void,
): Promise<MemoryPressure | null> {
  if (platform === 'darwin') {
    try {
      const { stdout } = await exec('memory_pressure', ['-Q'], { timeout: timeoutMs, maxBuffer: 64 * 1024 });
      const pressure = parseMemoryPressure(stdout);
      if (pressure) return pressure;
      pushError('memory pressure: unparsable');
    } catch {
      pushError('memory pressure: unavailable');
    }
    return null;
  }
  // Linux PSI is a cheap kernel file read, but keep the macOS panel's source
  // semantics explicit until a Linux-specific UI label is needed.
  if (platform === 'linux') {
    try {
      const text = fs.readFileSync('/proc/pressure/memory', 'utf8');
      const avg10 = Number(text.match(/^full .*?avg10=([\d.]+)/m)?.[1]);
      if (Number.isFinite(avg10)) {
        return { freePct: null, stallPct10: avg10, level: avg10 >= 5 ? 'critical' : avg10 >= 1 ? 'warn' : 'ok', source: 'psi' };
      }
      pushError('memory pressure: unparsable');
    } catch {
      pushError('memory pressure: unavailable');
    }
  }
  return null;
}

function measureEventLoopLag(): Promise<number> {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    setImmediate(() => resolve(Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1e6))));
  });
}

// --------------------------------------------------------------------------
// Filesystem usage (df) — distinct from the per-directory NanoClaw footprint
// --------------------------------------------------------------------------

export interface FsUsage {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usedPct: number;
}

/** Parse the last data row of `df -k <mount>` (BSD/macOS + GNU both fit this shape). */
export function parseDfK(stdout: string, mount: string): FsUsage | null {
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  // Filesystem  1K-blocks  Used  Avail  Capacity  ...  Mounted on
  const totalBytes = Number(cols[1]) * 1024;
  const usedBytes = Number(cols[2]) * 1024;
  const availBytes = Number(cols[3]) * 1024;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return {
    mount,
    totalBytes,
    usedBytes: Number.isFinite(usedBytes) ? usedBytes : 0,
    availBytes: Number.isFinite(availBytes) ? availBytes : 0,
    usedPct: Math.round((usedBytes / totalBytes) * 100),
  };
}

async function readFsUsage(exec: ExecFn, timeoutMs: number, mount: string): Promise<FsUsage | null> {
  const { stdout } = await exec('df', ['-k', mount], { timeout: timeoutMs, maxBuffer: 64 * 1024 });
  return parseDfK(stdout, mount);
}

// --------------------------------------------------------------------------
// Docker (health + memory + containers)
// --------------------------------------------------------------------------

export interface DockerMachine {
  /** docker CLI reachable at all (false ⇒ binary missing or every call failed). */
  available: boolean;
  daemonUp: boolean;
  containers: { name: string; image: string; status: string }[];
  containerCount: number;
  /** Memory the Docker Linux VM is allocated (macOS Docker Desktop). */
  vmMemTotalBytes: number | null;
  vmCpus: number | null;
  /** Aggregate resident memory across running containers (best-effort). */
  containersMemBytes: number | null;
}

/** Parse a human byte string like "123.4MiB", "2GiB", "512MB". */
export function parseHumanBytes(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.trim().match(/^([\d.]+)\s*([KMGTP]?i?)B?$/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2].toUpperCase();
  const binary = unit.endsWith('I');
  const letter = unit[0] ?? '';
  const base = binary ? 1024 : 1000;
  const exp = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5 }[letter] ?? 0;
  return Math.round(value * base ** exp);
}

async function readDockerMachine(
  exec: ExecFn,
  dockerStatusFn: () => Promise<DockerStatus>,
  timeoutMs: number,
  statsTimeoutMs: number,
  pushError: (msg: string) => void,
): Promise<DockerMachine> {
  const out: DockerMachine = {
    available: false,
    daemonUp: false,
    containers: [],
    containerCount: 0,
    vmMemTotalBytes: null,
    vmCpus: null,
    containersMemBytes: null,
  };
  let base: DockerStatus;
  try {
    base = await dockerStatusFn();
  } catch {
    pushError('docker: unavailable');
    return out;
  }
  out.daemonUp = base.daemonUp;
  out.available = base.daemonUp;
  out.containers = base.containers.slice(0, 100).map((c) => ({
    name: redactSecrets(c.name ?? ''),
    image: redactSecrets(c.image ?? ''),
    status: redactSecrets(c.status ?? ''),
  }));
  out.containerCount = out.containers.length;
  if (!base.daemonUp) {
    // Not an error to report — the daemon simply isn't up. `dockerStatus`
    // swallows the failure, so distinguish "down" from "no docker binary" by a
    // cheap probe below.
    try {
      await exec('docker', ['version', '--format', '{{.Client.Version}}'], {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
      });
      out.available = true; // client exists, daemon down
    } catch {
      out.available = false; // docker binary missing entirely
    }
    return out;
  }
  // VM memory + cpu count — one cheap call.
  try {
    const { stdout } = await exec('docker', ['info', '--format', '{{.MemTotal}}|{{.NCPU}}'], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    const [mem, cpus] = stdout.trim().split('|');
    out.vmMemTotalBytes = Number(mem) > 0 ? Number(mem) : null;
    out.vmCpus = Number(cpus) > 0 ? Number(cpus) : null;
  } catch {
    pushError('docker info: unavailable');
  }
  // Aggregate container memory — heaviest probe, tight timeout, best-effort.
  try {
    const { stdout } = await exec('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}'], {
      timeout: statsTimeoutMs,
      maxBuffer: MAX_BUFFER,
    });
    let total = 0;
    let any = false;
    for (const line of stdout.trim().split('\n').slice(0, 200)) {
      const used = parseHumanBytes(line.split('/')[0]);
      if (used != null) {
        total += used;
        any = true;
      }
    }
    out.containersMemBytes = any ? total : null;
  } catch {
    pushError('docker stats: unavailable');
  }
  return out;
}

// --------------------------------------------------------------------------
// Ops Center listener — the server's honest self-report
// --------------------------------------------------------------------------

export interface ListenerInfo {
  bound: boolean;
  address: string;
  port: number;
}

export interface ListenerStatus extends ListenerInfo {
  pid: number;
  uptimeSec: number;
}

// --------------------------------------------------------------------------
// Composed status
// --------------------------------------------------------------------------

export interface MachineStatus {
  ts: string;
  /** Machine vitals for the host running Ops Center. */
  host: HostVitals;
  disk: {
    /** Filesystem-level usage from `df` (null if unavailable). */
    fs: FsUsage | null;
    /** NanoClaw's own on-disk footprint (per-category + total). */
    nanoclaw: (DiskUsage & { totalBytes: number }) | null;
  };
  docker: DockerMachine;
  /** launchd services for this install. */
  services: { nanoclaw: HostService; opsCenter: HostService };
  onecli: OneCliStatus;
  /** Ops Center listener — a local fact, never a remote-path claim. */
  listener: ListenerStatus;
  /**
   * Remote frontend — SERVER-SIDE view only. Derived solely from the
   * client-contact heartbeat, never from {@link listener}. See tunnel-heartbeat.ts.
   */
  tunnel: TunnelServerView;
  /** Low-cost summary of queued/in-flight mission work from the collector. */
  mission: MissionHealth | null;
  /** Runtime responsiveness of the Ops Center process and this probe. */
  runtime: { eventLoopLagMs: number; probeDurationMs: number };
  /** Short, redacted labels for probes that failed this pass. */
  probeErrors: string[];
}

export interface MachineStatusDeps {
  /** Listener facts, supplied by the HTTP server (server.listening etc.). */
  listener: ListenerInfo;
  now?: () => number;
  exec?: ExecFn;
  timeoutMs?: number;
  dockerStatsTimeoutMs?: number;
  /** Filesystem mount to report for `df` (default '/'). */
  fsMount?: string;
  /** Override the OS platform gate for the macOS-version probe (default os.platform()). */
  platform?: string;
  tunnelThresholds?: TunnelThresholds;
  /** Read from the already-open ops.db by the server; no session DB scan here. */
  mission?: MissionHealth | null;
  /** Underlying probes — defaulted to the real ones, overridable in tests. */
  probes?: {
    detectHostService?: () => Promise<HostService>;
    detectOpsCenterService?: () => Promise<HostService>;
    dockerStatus?: () => Promise<DockerStatus>;
    diskUsage?: () => Promise<DiskUsage>;
    onecliStatus?: () => Promise<OneCliStatus>;
    lastClientContactMs?: () => number | null;
  };
}

/**
 * Assemble the full machine/system status. Independent probes run concurrently;
 * each is guarded so a single failure degrades one field rather than the whole
 * payload. Never throws.
 */
export async function machineStatus(deps: MachineStatusDeps): Promise<MachineStatus> {
  const probeStarted = process.hrtime.bigint();
  const now = deps.now ?? Date.now;
  const exec = deps.exec ?? (execFileP as ExecFn);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const statsTimeoutMs = deps.dockerStatsTimeoutMs ?? DEFAULT_DOCKER_STATS_TIMEOUT_MS;
  const fsMount = deps.fsMount ?? '/';
  const p = deps.probes ?? {};
  const detectHost = p.detectHostService ?? detectHostService;
  const detectOps = p.detectOpsCenterService ?? detectOpsCenterService;
  const dockerStatusFn = p.dockerStatus ?? dockerStatus;
  const diskUsageFn = p.diskUsage ?? diskUsage;
  const onecliFn = p.onecliStatus ?? onecliStatus;
  const lastContact = p.lastClientContactMs ?? getLastClientContactMs;

  const probeErrors: string[] = [];
  const pushError = (msg: string) => {
    if (probeErrors.length < 20) probeErrors.push(redactSecrets(msg));
  };

  const platform = deps.platform ?? os.platform();

  // Each probe resolves to a value or a fallback; failures are logged, never thrown.
  const osVersionP = readMacOsVersion(exec, timeoutMs, platform).catch(() => {
    pushError('sw_vers: unavailable');
    return { name: null, build: null };
  });
  const fsP = readFsUsage(exec, timeoutMs, fsMount).catch(() => {
    pushError('df: unavailable');
    return null;
  });
  const nanoclawDiskP = diskUsageFn()
    .then((d) => ({
      ...d,
      totalBytes: d.sessions + d.logs + d.backups + d.opsDb + d.centralDb + (d.dockerImage ?? 0),
    }))
    .catch(() => {
      pushError('disk usage: unavailable');
      return null;
    });
  const dockerP = readDockerMachine(exec, dockerStatusFn, timeoutMs, statsTimeoutMs, pushError);
  const nanoclawSvcP = detectHost().catch(() => {
    pushError('launchd (nanoclaw): unavailable');
    return { label: null, plist: null, pid: null, loaded: false, running: false } as HostService;
  });
  const opsSvcP = detectOps().catch(() => {
    pushError('launchd (ops-center): unavailable');
    return { label: null, plist: null, pid: null, loaded: false, running: false } as HostService;
  });
  const onecliP = onecliFn().catch(() => {
    pushError('onecli: unavailable');
    return { up: false, url: '', local: true } as OneCliStatus;
  });
  const memP = readMemUsage(exec, platform, timeoutMs).catch(() => {
    pushError('memory: unavailable');
    return osMemUsage();
  });
  const topCpuP = readTopCpuProcess(exec, platform, timeoutMs, pushError);
  const memoryPressureP = readMemoryPressure(exec, platform, timeoutMs, pushError);
  const eventLoopLagP = measureEventLoopLag();

  const [osVersion, fs, nanoclawDisk, docker, nanoclawSvc, opsSvc, onecli, mem, topProcess, memoryPressure, eventLoopLagMs] = await Promise.all([
    osVersionP,
    fsP,
    nanoclawDiskP,
    dockerP,
    nanoclawSvcP,
    opsSvcP,
    onecliP,
    memP,
    topCpuP,
    memoryPressureP,
    eventLoopLagP,
  ]);

  let host: HostVitals;
  try {
    host = readHostVitals(osVersion, mem, topProcess, memoryPressure);
  } catch {
    // os.* is effectively infallible, but never let it sink the payload.
    pushError('host vitals: unavailable');
    host = {
      hostname: '',
      platform: os.platform?.() ?? '',
      arch: os.arch?.() ?? '',
      kernel: '',
      osName: osVersion.name,
      osBuild: osVersion.build,
      uptimeSec: 0,
      cpu: { model: null, cores: 0, loadAvg: [0, 0, 0], loadPct: null, topProcess },
      mem,
      memoryPressure,
    };
  }

  const nowMs = now();
  const listener: ListenerStatus = {
    bound: deps.listener.bound,
    address: deps.listener.address,
    port: deps.listener.port,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  };

  return {
    ts: new Date(nowMs).toISOString(),
    host,
    disk: { fs, nanoclaw: nanoclawDisk },
    docker,
    services: { nanoclaw: nanoclawSvc, opsCenter: opsSvc },
    onecli,
    listener,
    tunnel: classifyTunnel(lastContact(), nowMs, deps.tunnelThresholds),
    mission: deps.mission ?? null,
    runtime: {
      eventLoopLagMs,
      probeDurationMs: Math.max(0, Math.round(Number(process.hrtime.bigint() - probeStarted) / 1e6)),
    },
    probeErrors,
  };
}
