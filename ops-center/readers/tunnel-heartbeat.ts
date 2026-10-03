/**
 * Remote-access heartbeat — the server's in-memory record of the most recent
 * moment a client reached the Ops Center loopback listener.
 *
 * Featherweight by design: one module-level timestamp, no DB, no allocation on
 * the hot path. The host may be resource-constrained, so this must stay effectively
 * free — a single assignment per client contact.
 *
 * CRITICAL DISTINCTION (see the panel requirement): recording a contact means
 * *some* client reached the *local* listener. It is NOT proof that a particular
 * Tailscale Serve, reverse-proxy, or SSH path is healthy — the very same request
 * could be a local `curl` on the server. A bound/listening server must therefore
 * never claim the remote path is up. The authoritative check is client-side:
 * the browser measures whether it can reach this endpoint. This module
 * deliberately exposes only the honest, caveated server-side signal.
 */

export type TunnelServerState = 'recent-client-contact' | 'stale-client-contact' | 'no-client-contact';

/** Milliseconds since epoch of the last client contact; null until the first. */
let lastClientContactMs: number | null = null;

/** Record that a client just reached the loopback listener. O(1), no I/O. */
export function recordClientContact(nowMs: number): void {
  lastClientContactMs = nowMs;
}

/** The last recorded client-contact timestamp (ms), or null if none this session. */
export function getLastClientContactMs(): number | null {
  return lastClientContactMs;
}

/** Test-only: clear the in-memory heartbeat so cases start from a clean slate. */
export function _resetTunnelHeartbeat(): void {
  lastClientContactMs = null;
}

export interface TunnelThresholds {
  /** Contact newer than this ⇒ "recent"; anything older is merely "stale". */
  recentMs: number;
}

export const DEFAULT_TUNNEL_THRESHOLDS: TunnelThresholds = {
  recentMs: 30_000,
};

export interface TunnelServerView {
  lastClientContactMs: number | null;
  lastClientContactAgeMs: number | null;
  serverSideState: TunnelServerState;
  /** Disclaimer surfaced verbatim in the API + UI so nothing over-claims. */
  note: string;
}

/**
 * The single source of the disclaimer, kept next to the logic it qualifies so
 * the two can never drift apart.
 */
export const TUNNEL_SERVER_NOTE =
  'Server-side signal only: this reflects that a client reached the loopback ' +
  'listener, not that the remote frontend path is up. A bound listener is never ' +
  'proof of a healthy remote path. The authoritative check runs client-side in ' +
  'the browser.';

/**
 * Classify the server-side tunnel signal purely from the last-contact timestamp.
 * Pure and deterministic (time is injected) so it is trivially testable. Note the
 * function has no access to listener state — by construction it cannot conflate
 * "listener bound" with "remote path healthy".
 */
export function classifyTunnel(
  lastMs: number | null,
  nowMs: number,
  thresholds: TunnelThresholds = DEFAULT_TUNNEL_THRESHOLDS,
): TunnelServerView {
  if (lastMs == null) {
    return {
      lastClientContactMs: null,
      lastClientContactAgeMs: null,
      serverSideState: 'no-client-contact',
      note: TUNNEL_SERVER_NOTE,
    };
  }
  const ageMs = Math.max(0, nowMs - lastMs);
  const serverSideState: TunnelServerState =
    ageMs <= thresholds.recentMs ? 'recent-client-contact' : 'stale-client-contact';
  return { lastClientContactMs: lastMs, lastClientContactAgeMs: ageMs, serverSideState, note: TUNNEL_SERVER_NOTE };
}
