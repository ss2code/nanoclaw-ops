/**
 * Dedicated hardening regression suite (docs/fork-customizations.md —
 * "Hardened errand runner"). Covers the host-side pieces:
 *
 *   - ensureHardenedTopology: build / reuse / recreate-on-change and every
 *     fail-closed path (empty allowlist, network create failure, filter
 *     crash-on-start). Docker is faked at the execFileSync boundary.
 *   - allowlist fingerprint stability (order/case/whitespace insensitive).
 *   - configFromDb: hardening JSON round-trip and the off (null) default.
 *
 * The filter proxy's own allow/deny logic is tested in the container tree
 * (container/filter-proxy/allowlist.test.ts, bun). The caps→docker-args
 * mapping is asserted in container-runner.test.ts.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const execFileSync = vi.fn();
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSync(...args) };
});

vi.mock('./egress-lockdown.js', () => ({
  EGRESS_NETWORK: 'nanoclaw-egress',
  establishEgressNetwork: vi.fn(),
  onecliGatewayContainer: () => 'onecli-gateway',
}));

const { ensureHardenedTopology, hardenedNetworkName, filterContainerName, HardeningError } =
  await import('./egress-filter.js');
const { configFromDb } = await import('./container-config.js');
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * Stateful docker fake behind execFileSync. Tracks networks and the filter
 * container (including the allowlist-hash label stamped at `run`), so reuse
 * and recreate flows behave like the real daemon.
 */
class DockerFake {
  networks = new Set<string>(['nanoclaw-egress']);
  filter: { name: string; hash: string; running: boolean; networks: string[] } | null = null;
  failNetworkCreate = false;
  crashFilterOnStart = false;
  calls: string[][] = [];

  handle(args: string[]): string {
    this.calls.push(args);
    const cmd = args.join(' ');
    if (args[0] === 'network' && args[1] === 'inspect') {
      if (this.networks.has(args[2])) return '{}';
      throw new Error(`no such network: ${args[2]}`);
    }
    if (args[0] === 'network' && args[1] === 'create') {
      if (this.failNetworkCreate) throw new Error('network create refused');
      this.networks.add(args[args.length - 1]);
      return '';
    }
    if (args[0] === 'network' && args[1] === 'connect') {
      if (this.filter && args[3] === this.filter.name) this.filter.networks.push(args[2]);
      return '';
    }
    if (args[0] === 'inspect') {
      const name = args[args.length - 1];
      if (!this.filter || this.filter.name !== name) throw new Error(`no such container: ${name}`);
      return `${this.filter.running}|${this.filter.hash}|${this.filter.networks.join(' ')} `;
    }
    if (args[0] === 'rm') {
      this.filter = null;
      return '';
    }
    if (args[0] === 'run') {
      const label = args.find((a) => a.startsWith('nanoclaw-filter-allowlist='));
      const network = args[args.indexOf('--network') + 1];
      const name = args[args.indexOf('--name') + 1];
      this.filter = {
        name,
        hash: label ? label.split('=')[1] : '',
        running: !this.crashFilterOnStart,
        networks: [network],
      };
      return '';
    }
    if (args[0] === 'logs') return 'boom: bad mount';
    throw new Error(`DockerFake: unhandled ${cmd}`);
  }

  ran(prefix: string): string[][] {
    return this.calls.filter((c) => c.join(' ').startsWith(prefix));
  }
}

let docker: DockerFake;

beforeEach(() => {
  docker = new DockerFake();
  execFileSync.mockReset();
  execFileSync.mockImplementation((_bin: unknown, args: unknown) => docker.handle(args as string[]));
  vi.useFakeTimers();
});

/** ensureHardenedTopology awaits a 500ms crash-check delay — drive it. */
async function ensure(folder: string, hosts: string[]): Promise<string> {
  const p = ensureHardenedTopology(folder, hosts);
  // Attach a no-op catch so a rejection isn't "unhandled" while timers advance.
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(600);
  return p;
}

describe('naming', () => {
  it('derives per-group network and filter names from the folder', () => {
    expect(hardenedNetworkName('errand-runner')).toBe('nanoclaw-hardened-errand-runner');
    expect(filterContainerName('errand-runner')).toBe('nanoclaw-filter-errand-runner');
  });
});

describe('ensureHardenedTopology', () => {
  it('fail-closed: empty allowHosts throws before touching docker', async () => {
    await expect(ensure('g1', [])).rejects.toThrow(HardeningError);
    expect(docker.calls).toHaveLength(0);
  });

  it('builds the topology from scratch and returns the per-group network', async () => {
    const network = await ensure('g1', ['api.openai.com']);
    expect(network).toBe('nanoclaw-hardened-g1');
    expect(docker.networks.has('nanoclaw-hardened-g1')).toBe(true);

    const run = docker.ran('run')[0];
    expect(run).toContain('--network-alias');
    expect(run).toContain('host.docker.internal');
    expect(run).toContain('FILTER_ALLOW_HOSTS=api.openai.com');
    expect(run).toContain('FILTER_UPSTREAM_HOST=onecli-gateway');
    // filter joins the shared egress network as its upstream side
    expect(docker.filter?.networks).toContain('nanoclaw-egress');
  });

  it('reuses a healthy filter with an unchanged allowlist (no second run)', async () => {
    await ensure('g1', ['api.openai.com', 'B.com']);
    expect(docker.ran('run')).toHaveLength(1);

    // order / case / whitespace must not change the fingerprint
    await ensure('g1', ['  b.COM ', 'API.OPENAI.COM']);
    expect(docker.ran('run')).toHaveLength(1);
    expect(docker.ran('rm')).toHaveLength(0);
  });

  it('recreates the filter when the allowlist actually changes', async () => {
    await ensure('g1', ['api.openai.com']);
    await ensure('g1', ['api.openai.com', 'api.anthropic.com']);
    expect(docker.ran('rm')).toHaveLength(1);
    expect(docker.ran('run')).toHaveLength(2);
    expect(docker.ran('run')[1]).toContain('FILTER_ALLOW_HOSTS=api.openai.com,api.anthropic.com');
  });

  it('recreates a stopped filter even with an unchanged allowlist', async () => {
    await ensure('g1', ['api.openai.com']);
    docker.filter!.running = false;
    await ensure('g1', ['api.openai.com']);
    expect(docker.ran('run')).toHaveLength(2);
  });

  it('fail-closed: network create failure refuses the spawn', async () => {
    docker.failNetworkCreate = true;
    await expect(ensure('g1', ['api.openai.com'])).rejects.toThrow(/network could not be created/);
    expect(docker.ran('run')).toHaveLength(0);
  });

  it('fail-closed: a filter that exits immediately is removed and the spawn refused', async () => {
    docker.crashFilterOnStart = true;
    await expect(ensure('g1', ['api.openai.com'])).rejects.toThrow(/exited immediately/);
    expect(docker.ran('rm')).toHaveLength(1); // cleanup of the dead filter
    expect(docker.filter).toBeNull();
  });
});

describe('configFromDb hardening parse', () => {
  const group = { id: 'ag-1', name: 'Errand Runner', folder: 'errand-runner' } as AgentGroup;
  const baseRow: ContainerConfigRow = {
    agent_group_id: 'ag-1',
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    hardening: null,
    model_tiers: null,
    updated_at: '2026-07-12T00:00:00Z',
  };

  it('round-trips a hardening profile from the DB row', () => {
    const hardening = {
      egress: true,
      allowHosts: ['openrouter.ai'],
      caps: { cpus: '1', memory: '1g', pidsLimit: 256, noNewPrivileges: true, capDrop: true },
      scrub: true,
      hubAccess: 'read-only',
    };
    const cfg = configFromDb({ ...baseRow, hardening: JSON.stringify(hardening) }, group);
    expect(cfg.hardening).toEqual(hardening);
  });

  it('null column means hardening off (undefined, not a default profile)', () => {
    expect(configFromDb(baseRow, group).hardening).toBeUndefined();
  });
});
