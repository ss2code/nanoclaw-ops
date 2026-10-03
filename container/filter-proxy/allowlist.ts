/**
 * Pure host-allowlist matching for the egress filter proxy.
 *
 * Patterns are either exact hostnames (`openrouter.ai`) or single-label-onward
 * wildcards (`*.openrouter.ai`, matching any subdomain but NOT the apex —
 * list both if both are needed). Matching is case-insensitive. No ports, no
 * paths, no schemes: the caller extracts the hostname from the CONNECT target.
 *
 * Runtime-agnostic (no bun/node imports) so the host test suite can cover it
 * while the server runs under Bun.
 */

/** Normalize a pattern or hostname: lowercase, trim, strip trailing dot. */
function norm(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** Parse a comma-separated allowlist env value into clean patterns. */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(norm)
    .filter(Boolean);
}

/** True when `host` matches one of the allowlist patterns. */
export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = norm(host);
  if (!h) return false;
  for (const p of patterns) {
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".domain.tld"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

/**
 * Parse the target of an HTTP CONNECT request line ("host:port").
 * Returns null for anything malformed. IPv6 literals are rejected on
 * purpose — the allowlist is name-based and the gateway resolves names.
 */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(target.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: norm(m[1]), port };
}
