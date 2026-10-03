/**
 * Egress lockdown — force ALL agent traffic through the OneCLI gateway.
 * Agents run on a Docker `--internal` network (no internet route) with the
 * gateway attached as host.docker.internal, so the injected proxy is the only
 * reachable hop. Non-root, no NET_ADMIN — the agent can't undo it.
 *
 * Fail-fast: when the flag is on but the network/gateway can't be set up, throw
 * rather than silently spawn an agent with open egress.
 */
import { execFileSync } from 'child_process';

import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

/** Locked-down, no-internet network agents are placed on. */
export const EGRESS_NETWORK = process.env.NANOCLAW_EGRESS_NETWORK || 'nanoclaw-egress';
/** The OneCLI gateway container attached as the only egress hop. */
const ONECLI_GATEWAY_CONTAINER = process.env.ONECLI_GATEWAY_CONTAINER || 'onecli';
/** Off by default; set NANOCLAW_EGRESS_LOCKDOWN=true to opt in. */
const EGRESS_LOCKDOWN = process.env.NANOCLAW_EGRESS_LOCKDOWN === 'true';

/** Raised when lockdown is requested but can't be established. */
export class EgressLockdownError extends Error {
  constructor(reason: string) {
    super(
      `Egress lockdown is on (NANOCLAW_EGRESS_LOCKDOWN=true) but ${reason}. ` +
        `Refusing to spawn with open egress. Start the OneCLI gateway container ` +
        `"${ONECLI_GATEWAY_CONTAINER}", or set NANOCLAW_EGRESS_LOCKDOWN=false to opt out.`,
    );
    this.name = 'EgressLockdownError';
  }
}

function dockerOk(args: string[]): boolean {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Is the OneCLI gateway currently attached to the egress network? */
function gatewayAttached(): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', EGRESS_NETWORK, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    return out.split(/\s+/).includes(ONECLI_GATEWAY_CONTAINER);
  } catch {
    return false;
  }
}

/**
 * Ensure the egress network exists with the OneCLI gateway attached (aliased
 * host.docker.internal). Idempotent + self-healing. Returns false when lockdown
 * is disabled (caller uses the host gateway), true when it's active. Throws
 * EgressLockdownError when enabled but unestablishable — fail fast rather than
 * spawn an agent with open egress.
 */
export function ensureEgressNetwork(): boolean {
  if (!EGRESS_LOCKDOWN) return false;
  establishEgressNetwork();
  return true;
}

/**
 * Flag-independent primitive: build the egress network + gateway attachment
 * or throw. Used by the global lockdown path above and by per-group hardening
 * (src/egress-filter.ts), which needs the gateway reachable on this network
 * for the filter proxy's upstream side regardless of the global env flag.
 */
export function establishEgressNetwork(): void {
  if (
    !dockerOk(['network', 'inspect', EGRESS_NETWORK]) &&
    !dockerOk(['network', 'create', '--internal', EGRESS_NETWORK])
  ) {
    throw new EgressLockdownError(`the "${EGRESS_NETWORK}" internal network could not be created`);
  }

  if (gatewayAttached()) return;

  if (
    dockerOk(['network', 'connect', '--alias', 'host.docker.internal', EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER]) &&
    gatewayAttached()
  ) {
    log.info('Egress lockdown: OneCLI gateway attached', {
      network: EGRESS_NETWORK,
      gateway: ONECLI_GATEWAY_CONTAINER,
    });
    return;
  }

  throw new EgressLockdownError(
    `the OneCLI gateway "${ONECLI_GATEWAY_CONTAINER}" could not be attached to "${EGRESS_NETWORK}"`,
  );
}

/** Name of the OneCLI gateway container (the filter proxy's upstream). */
export function onecliGatewayContainer(): string {
  return ONECLI_GATEWAY_CONTAINER;
}

/** CLI args placing a container on the locked-down egress network. */
export function egressNetworkArgs(): string[] {
  return ['--network', EGRESS_NETWORK];
}
