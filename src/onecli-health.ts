export type OneCliFailureKind = 'configuration' | 'unreachable' | 'incompatible' | 'unauthorized' | 'unhealthy' | 'sdk';

export class OneCliHealthError extends Error {
  constructor(
    public readonly kind: Exclude<OneCliFailureKind, 'sdk'>,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OneCliHealthError';
  }
}

export class OneCliCircuitOpenError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    public readonly lastFailureKind: OneCliFailureKind | null,
  ) {
    super(`OneCLI wake circuit is open; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'OneCliCircuitOpenError';
  }
}

export interface OneCliHealthResult {
  url: string;
  status: number;
}

export interface OneCliHealthOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Build the versioned health URL used by the OneCLI SDK compatibility check. */
export function oneCliHealthUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) throw new OneCliHealthError('configuration', 'ONECLI_URL is not configured');
  return normalized.endsWith('/v1') ? `${normalized}/health` : `${normalized}/v1/health`;
}

function classifyStatus(status: number): Exclude<OneCliFailureKind, 'sdk' | 'configuration' | 'unreachable'> | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'incompatible';
  return 'unhealthy';
}

/** Probe OneCLI without invoking the SDK or starting a container. */
export async function checkOneCliHealth(
  baseUrl: string | undefined,
  options: OneCliHealthOptions = {},
): Promise<OneCliHealthResult> {
  if (!baseUrl) throw new OneCliHealthError('configuration', 'ONECLI_URL is not configured');
  const url = oneCliHealthUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } catch (err) {
      throw new OneCliHealthError(
        'unreachable',
        `OneCLI gateway is unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const failureKind = classifyStatus(response.status);
    if (failureKind) {
      throw new OneCliHealthError(
        failureKind,
        `OneCLI gateway health check failed at ${url} with HTTP ${response.status}`,
        response.status,
      );
    }
    return { url, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

export interface OneCliWakeCircuitSnapshot {
  consecutiveFailures: number;
  blockedUntil: number;
  lastFailureKind: OneCliFailureKind | null;
}

/**
 * Process-local backoff shared by all wake attempts. The host sweep remains
 * the retry authority; this circuit only prevents a down gateway from causing
 * every due session to repeat the same preflight/SDK work immediately.
 */
export class OneCliWakeCircuit {
  private consecutiveFailures = 0;
  private blockedUntil = 0;
  private lastFailureKind: OneCliFailureKind | null = null;

  private static readonly BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

  canAttempt(now = Date.now()): boolean {
    return now >= this.blockedUntil;
  }

  retryAfterMs(now = Date.now()): number {
    return Math.max(0, this.blockedUntil - now);
  }

  recordFailure(kind: OneCliFailureKind, now = Date.now()): void {
    const delay =
      OneCliWakeCircuit.BACKOFF_MS[Math.min(this.consecutiveFailures, OneCliWakeCircuit.BACKOFF_MS.length - 1)];
    this.consecutiveFailures += 1;
    this.blockedUntil = now + delay;
    this.lastFailureKind = kind;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.blockedUntil = 0;
    this.lastFailureKind = null;
  }

  snapshot(): OneCliWakeCircuitSnapshot {
    return {
      consecutiveFailures: this.consecutiveFailures,
      blockedUntil: this.blockedUntil,
      lastFailureKind: this.lastFailureKind,
    };
  }
}
