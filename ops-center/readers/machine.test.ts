import { beforeEach, describe, expect, it } from 'vitest';

import {
  machineStatus,
  parseDfK,
  parseHumanBytes,
  parseMemoryPressure,
  parsePsCpu,
  parseVmStat,
  redactSecrets,
  _resetOsVersionCache,
  type ExecFn,
  type MachineStatusDeps,
} from './machine.js';
import {
  classifyTunnel,
  getLastClientContactMs,
  recordClientContact,
  _resetTunnelHeartbeat,
} from './tunnel-heartbeat.js';
import type { DockerStatus, HostService, OneCliStatus } from './system.js';

const NOW = 1_700_000_000_000;

const VM_STAT_SAMPLE = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                6407.',
  'Pages active:                             97427.',
  'Pages inactive:                           96597.',
  'Pages wired down:                         85892.',
  'Pages occupied by compressor:            201623.',
  '',
].join('\n');

const svc = (over: Partial<HostService> = {}): HostService => ({
  label: 'com.nanoclaw-v2-abc',
  plist: '/x.plist',
  pid: 1234,
  loaded: true,
  running: true,
  ...over,
});

const dockerUp = (over: Partial<DockerStatus> = {}): DockerStatus => ({
  daemonUp: true,
  containers: [{ id: 'a', name: 'nanoclaw-v2-owner-1', image: 'nanoclaw-agent:latest', status: 'Up 2 hours' }],
  imageSizeBytes: 1024,
  ...over,
});

const onecliUp: OneCliStatus = { up: true, url: 'http://127.0.0.1:10254', local: true };

/** Base deps that keep every probe healthy; individual tests override pieces. */
function baseDeps(over: Partial<MachineStatusDeps> = {}): MachineStatusDeps {
  const exec: ExecFn = async (cmd, args) => {
    if (cmd === 'sw_vers')
      return { stdout: 'ProductName:\tmacOS\nProductVersion:\t15.5\nBuildVersion:\t24F74\n', stderr: '' };
    if (cmd === 'vm_stat') return { stdout: VM_STAT_SAMPLE, stderr: '' };
    if (cmd === 'memory_pressure') return { stdout: 'System-wide memory free percentage: 44%\n', stderr: '' };
    if (cmd === 'ps') return { stdout: '  999  96.4 /usr/bin/resource-hog\n  123   4.2 node\n', stderr: '' };
    if (cmd === 'df')
      return {
        stdout:
          'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 971350180 123456789 800000000 14% /\n',
        stderr: '',
      };
    if (cmd === 'docker' && args[0] === 'info') return { stdout: '8589934592|4\n', stderr: '' };
    if (cmd === 'docker' && args[0] === 'stats') return { stdout: '123.4MiB / 2GiB\n45MiB / 2GiB\n', stderr: '' };
    if (cmd === 'docker' && args[0] === 'version') return { stdout: '27.0.0\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return {
    listener: { bound: true, address: '127.0.0.1', port: 10333 },
    now: () => NOW,
    exec,
    platform: 'darwin',
    probes: {
      detectHostService: async () => svc(),
      detectOpsCenterService: async () => svc({ label: 'com.nanoclaw.opscenter-abc', pid: 5678 }),
      dockerStatus: async () => dockerUp(),
      diskUsage: async () => ({ sessions: 10, logs: 20, backups: 30, opsDb: 40, centralDb: 50, dockerImage: 60 }),
      onecliStatus: async () => onecliUp,
      lastClientContactMs: () => null,
    },
    ...over,
  };
}

beforeEach(() => {
  _resetOsVersionCache();
  _resetTunnelHeartbeat();
});

describe('redactSecrets', () => {
  it('masks credential-shaped KEY=value / KEY: value assignments', () => {
    const fakeOpenAiKey = ['sk-', 'verysecretkeyvalue1234'].join('');
    expect(redactSecrets(`OPENAI_API_KEY=${fakeOpenAiKey}`)).toBe('OPENAI_API_KEY=***');
    const fakePassword = ['password=', 'hunter2trustno1'].join('');
    expect(redactSecrets(fakePassword)).toBe('password=***');
    const fakeAuthToken = ['ANTHROPIC_AUTH_TOKEN: ', 'abcd1234efgh5678ijkl'].join('');
    expect(redactSecrets(fakeAuthToken)).toMatch(/ANTHROPIC_AUTH_TOKEN=\*\*\*/);
    expect(redactSecrets('DB_SESSION_COOKIE="zzzzzzzzzzzzzzzz"')).toBe('DB_SESSION_COOKIE=***');
  });

  it('masks opaque token shapes anywhere they appear', () => {
    expect(redactSecrets('using sk-abcdefghijklmnopqrstuvwx now')).toBe('using *** now');
    // The bearer token must be masked and must never survive, however the scheme
    // word collides with the KV rule.
    const authRedacted = redactSecrets('Authorization: Bearer abcdefghijklmnop.tokenpart');
    expect(authRedacted).not.toContain('abcdefghijklmnop.tokenpart');
    expect(authRedacted).toContain('***');
    const githubToken = ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    expect(redactSecrets(`key ${githubToken}`)).toBe('key ***');
    expect(redactSecrets(`aws ${awsKey} done`)).toBe('aws *** done');
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4'].join('');
    expect(redactSecrets(`token ${jwt}`)).toBe('token ***');
  });

  it('masks long opaque hex / base64 blobs but leaves ordinary text intact', () => {
    expect(redactSecrets('abc123def456abc123def456abc123def456')).toBe('***'); // 36 hex chars
    expect(redactSecrets('the docker daemon is up with 3 containers')).toBe(
      'the docker daemon is up with 3 containers',
    );
    expect(redactSecrets('macOS 15.5 arm64 kernel 25.0.0')).toBe('macOS 15.5 arm64 kernel 25.0.0');
  });

  it('is a no-op on empty input', () => {
    expect(redactSecrets('')).toBe('');
  });
});

describe('parseHumanBytes', () => {
  it('parses binary and decimal units', () => {
    expect(parseHumanBytes('123.4MiB')).toBe(Math.round(123.4 * 1024 ** 2));
    expect(parseHumanBytes('2GiB')).toBe(2 * 1024 ** 3);
    expect(parseHumanBytes('512MB')).toBe(512 * 1000 ** 2);
    expect(parseHumanBytes('900B')).toBe(900);
    expect(parseHumanBytes('0B')).toBe(0);
  });
  it('returns null for junk', () => {
    expect(parseHumanBytes(undefined)).toBeNull();
    expect(parseHumanBytes('n/a')).toBeNull();
    expect(parseHumanBytes('')).toBeNull();
  });
});

describe('parseDfK', () => {
  it('parses the last data row of df -k into bytes', () => {
    const out = parseDfK(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 1000 400 600 40% /\n',
      '/',
    );
    expect(out).toEqual({
      mount: '/',
      totalBytes: 1000 * 1024,
      usedBytes: 400 * 1024,
      availBytes: 600 * 1024,
      usedPct: 40,
    });
  });
  it('returns null when there is no data row', () => {
    expect(parseDfK('Filesystem 1024-blocks Used Available Capacity Mounted on\n', '/')).toBeNull();
    expect(parseDfK('', '/')).toBeNull();
  });
});

describe('parseVmStat (honest macOS memory)', () => {
  it('computes used = (active + wired + compressed) * pageSize', () => {
    const total = 8_589_934_592;
    const out = parseVmStat(VM_STAT_SAMPLE, total);
    expect(out).not.toBeNull();
    expect(out!.usedBytes).toBe((97427 + 85892 + 201623) * 16384);
    expect(out!.usedPct).toBe(73); // not the misleading ~98% os.freemem() gives
    expect(out!.freeBytes).toBe(total - out!.usedBytes);
    expect(out!.source).toBe('vm_stat');
  });
  it('returns null when required fields are missing (caller falls back to os)', () => {
    expect(parseVmStat('garbage output', 1000)).toBeNull();
    expect(parseVmStat('Pages active: 1.', 0)).toBeNull();
  });
});

describe('parseMemoryPressure', () => {
  it('parses the macOS free-percentage signal and classifies pressure', () => {
    expect(parseMemoryPressure('System-wide memory free percentage: 44%\n')).toEqual({
      freePct: 44,
      stallPct10: null,
      level: 'ok',
      source: 'memory_pressure',
    });
    expect(parseMemoryPressure('System-wide memory free percentage: 15%\n')?.level).toBe('warn');
    expect(parseMemoryPressure('System-wide memory free percentage: 4%\n')?.level).toBe('critical');
  });

  it('returns null for output without a pressure signal', () => {
    expect(parseMemoryPressure('memory pressure unavailable')).toBeNull();
  });
});

describe('parsePsCpu', () => {
  it('returns the highest CPU processes with bounded, basename-only labels', () => {
    expect(parsePsCpu('  12  4.2 /usr/bin/node\n  99  101.7 /Applications/Worker.app/Contents/MacOS/worker\n')).toEqual(
      [
        { pid: 99, cpuPct: 101.7, command: 'worker' },
        { pid: 12, cpuPct: 4.2, command: 'node' },
      ],
    );
  });
});

describe('classifyTunnel (server-side signal only)', () => {
  it('reports no-client-contact when nothing has been recorded', () => {
    const v = classifyTunnel(null, NOW);
    expect(v.serverSideState).toBe('no-client-contact');
    expect(v.lastClientContactAgeMs).toBeNull();
    expect(v.note).toMatch(/not.*proof|never proof|not that the SSH tunnel/i);
  });
  it('reports recent-client-contact for a fresh heartbeat', () => {
    expect(classifyTunnel(NOW - 5_000, NOW).serverSideState).toBe('recent-client-contact');
  });
  it('reports stale-client-contact for an old heartbeat', () => {
    const v = classifyTunnel(NOW - 10 * 60_000, NOW);
    expect(v.serverSideState).toBe('stale-client-contact');
    expect(v.lastClientContactAgeMs).toBe(10 * 60_000);
  });
});

describe('tunnel heartbeat store', () => {
  it('records and reads back the last client contact', () => {
    expect(getLastClientContactMs()).toBeNull();
    recordClientContact(NOW);
    expect(getLastClientContactMs()).toBe(NOW);
    expect(classifyTunnel(getLastClientContactMs(), NOW + 1000).serverSideState).toBe('recent-client-contact');
  });
});

describe('machineStatus — tunnel vs server/listener distinction', () => {
  it('does NOT claim the tunnel is healthy just because the listener is bound', async () => {
    const s = await machineStatus(baseDeps({ listener: { bound: true, address: '127.0.0.1', port: 10333 } }));
    // Listener is bound...
    expect(s.listener.bound).toBe(true);
    // ...yet with no client heartbeat the tunnel is explicitly NOT healthy.
    expect(s.tunnel.serverSideState).toBe('no-client-contact');
    expect(s.tunnel.lastClientContactMs).toBeNull();
    // No field anywhere derives a truthy tunnel-health verdict from the listener.
    expect(JSON.stringify(s.tunnel)).not.toMatch(/"healthy":\s*true/);
    expect(s.tunnel.note).toMatch(/not.*proof|not that the SSH tunnel|bound listener/i);
  });

  it('reflects a recent client contact once the heartbeat is recorded — independent of the listener', async () => {
    const s = await machineStatus(
      baseDeps({ probes: { ...baseDeps().probes, lastClientContactMs: () => NOW - 3_000 } }),
    );
    expect(s.tunnel.serverSideState).toBe('recent-client-contact');
    expect(s.tunnel.lastClientContactAgeMs).toBe(3_000);
    // Still a server-side signal — the disclaimer is always present.
    expect(s.tunnel.note.length).toBeGreaterThan(20);
  });

  it('packages the listener as a local fact (pid + process uptime)', async () => {
    const s = await machineStatus(baseDeps());
    expect(s.listener).toMatchObject({ bound: true, address: '127.0.0.1', port: 10333 });
    expect(s.listener.pid).toBe(process.pid);
    expect(s.listener.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

describe('machineStatus — unavailable tools degrade gracefully (never throw)', () => {
  it('handles a host with no docker/df/sw_vers binaries', async () => {
    const enoent: ExecFn = async () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    };
    const s = await machineStatus(
      baseDeps({
        exec: enoent,
        probes: {
          ...baseDeps().probes,
          dockerStatus: async () => ({ daemonUp: false, containers: [], imageSizeBytes: null }),
        },
      }),
    );
    expect(s.disk.fs).toBeNull();
    expect(s.docker.daemonUp).toBe(false);
    expect(s.docker.available).toBe(false); // docker version probe also ENOENT'd
    expect(s.host.osName).toBeNull(); // sw_vers unavailable
    expect(s.probeErrors).toContain('df: unavailable');
    expect(s.probeErrors).toContain('sw_vers: unavailable');
    // Host vitals from the os module still populate.
    expect(typeof s.host.hostname).toBe('string');
    expect(s.host.cpu.loadAvg).toHaveLength(3);
    expect(s.host.mem.source).toBe('os'); // vm_stat ENOENT'd → graceful fallback
  });

  it('distinguishes daemon-down from docker-absent when the client binary exists', async () => {
    const onlyVersion: ExecFn = async (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'version') return { stdout: '27.0.0\n', stderr: '' };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const s = await machineStatus(
      baseDeps({
        exec: onlyVersion,
        probes: {
          ...baseDeps().probes,
          dockerStatus: async () => ({ daemonUp: false, containers: [], imageSizeBytes: null }),
        },
      }),
    );
    expect(s.docker.daemonUp).toBe(false);
    expect(s.docker.available).toBe(true); // client present, daemon down
  });
});

describe('machineStatus — timeouts degrade gracefully', () => {
  it('treats timed-out probes as unavailable without throwing', async () => {
    const timeout: ExecFn = async () => {
      // Shape promisify(execFile) produces on `timeout`.
      throw Object.assign(new Error('Command failed: timed out'), { killed: true, signal: 'SIGTERM', code: null });
    };
    const s = await machineStatus(baseDeps({ exec: timeout }));
    expect(s.disk.fs).toBeNull();
    expect(s.host.osName).toBeNull();
    // docker daemon reported up by the injected probe, but info/stats timed out.
    expect(s.docker.daemonUp).toBe(true);
    expect(s.docker.vmMemTotalBytes).toBeNull();
    expect(s.docker.containersMemBytes).toBeNull();
    expect(s.probeErrors).toEqual(
      expect.arrayContaining(['df: unavailable', 'docker info: unavailable', 'docker stats: unavailable']),
    );
  });
});

describe('machineStatus — redaction (no credentials / env in the payload)', () => {
  it('scrubs secrets that ride in on container name/image/status', async () => {
    const s = await machineStatus(
      baseDeps({
        probes: {
          ...baseDeps().probes,
          dockerStatus: async () => ({
            daemonUp: true,
            containers: [
              {
                id: 'x',
                name: `svc-${['AKIA', 'IOSFODNN7EXAMPLE'].join('')}`,
                image: `img:latest ANTHROPIC_API_KEY=${['sk', '-supersecretvalue12345'].join('')}`,
                status: `Up; TOKEN=${['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('')}`,
              },
            ],
            imageSizeBytes: 1,
          }),
        },
      }),
    );
    const blob = JSON.stringify(s);
    expect(blob).not.toContain(['AKIA', 'IOSFODNN7EXAMPLE'].join(''));
    expect(blob).not.toContain(['sk', '-supersecretvalue12345'].join(''));
    expect(blob).not.toContain(['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join(''));
    expect(s.docker.containers[0].name).toContain('***');
  });

  it('never dumps process environment variables into the payload', async () => {
    const marker = 'sk-envmarkershouldnotappear0000';
    process.env.NANOCLAW_TEST_SECRET = marker;
    try {
      const s = await machineStatus(baseDeps());
      expect(JSON.stringify(s)).not.toContain(marker);
    } finally {
      delete process.env.NANOCLAW_TEST_SECRET;
    }
  });
});

describe('machineStatus — healthy composition', () => {
  it('assembles host vitals, disk, docker memory, services, onecli, listener', async () => {
    const s = await machineStatus(baseDeps());
    expect(s.host.hostname.length).toBeGreaterThan(0);
    expect(s.host.osName).toBe('macOS 15.5');
    expect(s.host.osBuild).toBe('24F74');
    expect(s.host.arch.length).toBeGreaterThan(0);
    expect(s.host.mem.usedPct).toBeGreaterThanOrEqual(0);
    expect(s.host.mem.usedPct).toBeLessThanOrEqual(100);
    expect(s.host.mem.source).toBe('vm_stat'); // honest macOS figure, not os.freemem()
    expect(s.disk.fs).toEqual({
      mount: '/',
      totalBytes: 971350180 * 1024,
      usedBytes: 123456789 * 1024,
      availBytes: 800000000 * 1024,
      usedPct: 13,
    });
    expect(s.disk.nanoclaw?.totalBytes).toBe(10 + 20 + 30 + 40 + 50 + 60);
    expect(s.docker.vmMemTotalBytes).toBe(8589934592);
    expect(s.docker.vmCpus).toBe(4);
    expect(s.docker.containersMemBytes).toBe(parseHumanBytes('123.4MiB')! + parseHumanBytes('45MiB')!);
    expect(s.host.cpu.topProcess).toEqual({ pid: 999, cpuPct: 96.4, command: 'resource-hog' });
    expect(s.host.memoryPressure).toMatchObject({ freePct: 44, level: 'ok', source: 'memory_pressure' });
    expect(s.runtime.eventLoopLagMs).toBeGreaterThanOrEqual(0);
    expect(s.runtime.probeDurationMs).toBeGreaterThanOrEqual(0);
    expect(s.services.nanoclaw.running).toBe(true);
    expect(s.services.opsCenter.pid).toBe(5678);
    expect(s.onecli.up).toBe(true);
    expect(s.probeErrors).toEqual([]);
  });

  it('skips the sw_vers probe entirely on non-darwin hosts', async () => {
    let swVersCalls = 0;
    const exec: ExecFn = async (cmd) => {
      if (cmd === 'sw_vers') swVersCalls++;
      if (cmd === 'df') return { stdout: 'H\n/dev/x 1000 400 600 40% /\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const s = await machineStatus(
      baseDeps({
        platform: 'linux',
        exec,
        probes: {
          ...baseDeps().probes,
          dockerStatus: async () => ({ daemonUp: false, containers: [], imageSizeBytes: null }),
        },
      }),
    );
    expect(swVersCalls).toBe(0);
    expect(s.host.osName).toBeNull();
  });
});
