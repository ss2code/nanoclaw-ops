/**
 * Per-group hardened egress topology (opt-in via container_configs.hardening).
 *
 *   agent ── nanoclaw-hardened-<folder> (internal) ──> filter proxy ── nanoclaw-egress ──> OneCLI gateway
 *
 * The filter proxy container (container/filter-proxy/filter-proxy.ts, running
 * under Bun in the agent base image) holds the `host.docker.internal` alias on
 * the per-group network, so the OneCLI-injected proxy URL resolves to the
 * filter with no env rewriting. The filter relays CONNECTs for allowlisted
 * hosts to the real gateway (which still authenticates the agent's token and
 * injects credentials) and refuses everything else.
 *
 * Why a per-group network instead of reusing nanoclaw-egress directly: on a
 * shared network the agent could bypass the filter and reach the gateway
 * itself (it carries a valid proxy token), and hardened agents could reach
 * each other. The per-group network contains exactly two endpoints: the agent
 * and its filter.
 *
 * Fail-closed like egress-lockdown: any step failing refuses the spawn.
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import path from 'path';

import { CONTAINER_IMAGE, CONTAINER_INSTALL_LABEL } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { EGRESS_NETWORK, establishEgressNetwork, onecliGatewayContainer } from './egress-lockdown.js';
import { log } from './log.js';

const FILTER_LABEL = 'nanoclaw-filter-allowlist';
/** Gateway proxy port — both the filter's listen port (so the injected proxy
 *  URL's port works unchanged) and its upstream port on the gateway. */
const GATEWAY_PROXY_PORT = process.env.ONECLI_GATEWAY_PROXY_PORT || '10255';

export class HardeningError extends Error {
  constructor(reason: string) {
    super(`Hardened egress requested but ${reason}. Refusing to spawn with open or broken egress.`);
    this.name = 'HardeningError';
  }
}

export function hardenedNetworkName(folder: string): string {
  return `nanoclaw-hardened-${folder}`;
}

export function filterContainerName(folder: string): string {
  return `nanoclaw-filter-${folder}`;
}

function docker(args: string[]): string {
  return execFileSync(CONTAINER_RUNTIME_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 30000,
  });
}

function dockerOk(args: string[]): boolean {
  try {
    docker(args);
    return true;
  } catch {
    return false;
  }
}

/** Stable fingerprint of the allowlist, stamped as a label so config changes recreate the filter. */
function allowlistHash(allowHosts: string[]): string {
  return createHash('sha256')
    .update(
      [...allowHosts]
        .map((h) => h.trim().toLowerCase())
        .sort()
        .join(','),
    )
    .digest('hex')
    .slice(0, 16);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FilterState {
  running: boolean;
  hash: string;
  networks: string[];
}

function inspectFilter(name: string): FilterState | null {
  try {
    const out = docker([
      'inspect',
      '--format',
      `{{.State.Running}}|{{index .Config.Labels "${FILTER_LABEL}"}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}`,
      name,
    ]).trim();
    const [running, hash, networks] = out.split('|');
    return { running: running === 'true', hash, networks: networks.trim().split(/\s+/).filter(Boolean) };
  } catch {
    return null;
  }
}

/**
 * Build (or reuse) the hardened topology for an agent group. Returns the
 * per-group network name to pass as the agent container's `--network`.
 * Throws HardeningError on any failure — the caller must NOT spawn.
 */
export async function ensureHardenedTopology(folder: string, allowHosts: string[]): Promise<string> {
  if (allowHosts.length === 0) {
    throw new HardeningError('allowHosts is empty (nothing would be reachable — set hardening.allowHosts)');
  }

  // Gateway attached to the shared egress network (the filter's upstream side).
  establishEgressNetwork();

  const network = hardenedNetworkName(folder);
  if (!dockerOk(['network', 'inspect', network]) && !dockerOk(['network', 'create', '--internal', network])) {
    throw new HardeningError(`the "${network}" internal network could not be created`);
  }

  const name = filterContainerName(folder);
  const wantHash = allowlistHash(allowHosts);

  const existing = inspectFilter(name);
  if (existing) {
    if (
      existing.running &&
      existing.hash === wantHash &&
      existing.networks.includes(network) &&
      existing.networks.includes(EGRESS_NETWORK)
    ) {
      return network; // healthy, current config — reuse
    }
    // Stopped, stale allowlist, or detached from a network — recreate.
    if (!dockerOk(['rm', '-f', name])) {
      throw new HardeningError(`stale filter container "${name}" could not be removed`);
    }
  }

  const filterSrc = path.join(process.cwd(), 'container', 'filter-proxy');
  try {
    docker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      CONTAINER_INSTALL_LABEL,
      '--label',
      `${FILTER_LABEL}=${wantHash}`,
      '--restart',
      'unless-stopped',
      '--network',
      network,
      '--network-alias',
      'host.docker.internal',
      '-v',
      `${filterSrc}:/filter:ro`,
      '-e',
      `FILTER_ALLOW_HOSTS=${allowHosts.join(',')}`,
      '-e',
      `FILTER_UPSTREAM_HOST=${onecliGatewayContainer()}`,
      '-e',
      `FILTER_UPSTREAM_PORT=${GATEWAY_PROXY_PORT}`,
      '-e',
      `FILTER_LISTEN_PORT=${GATEWAY_PROXY_PORT}`,
      '--entrypoint',
      'bun',
      CONTAINER_IMAGE,
      'run',
      '/filter/filter-proxy.ts',
    ]);
    docker(['network', 'connect', EGRESS_NETWORK, name]);
  } catch (err) {
    dockerOk(['rm', '-f', name]);
    throw new HardeningError(`the filter proxy "${name}" could not be started (${String(err).slice(0, 200)})`);
  }

  // Catch instant crashes (bad mount, bun error) before declaring the topology up.
  await delay(500);
  const state = inspectFilter(name);
  if (!state?.running) {
    let logs = '';
    try {
      logs = docker(['logs', '--tail', '5', name]);
    } catch {
      /* container may be gone */
    }
    dockerOk(['rm', '-f', name]);
    throw new HardeningError(
      `the filter proxy "${name}" exited immediately${logs ? ` — ${logs.trim().slice(0, 300)}` : ''}`,
    );
  }

  log.info('Hardened egress topology ready', { folder, network, filter: name, allowHosts });
  return network;
}
