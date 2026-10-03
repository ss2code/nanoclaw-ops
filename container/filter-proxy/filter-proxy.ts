/**
 * Egress filter proxy — the only hop out of a hardened agent's network.
 *
 * Topology (built by src/egress-filter.ts on the host):
 *   agent container ── nanoclaw-hardened-<group> ──> THIS PROXY ── nanoclaw-egress ──> OneCLI gateway
 *
 * This container holds the `host.docker.internal` alias on the per-group
 * internal network, so the agent's OneCLI-injected proxy URL
 * (http://x:<token>@host.docker.internal:10255) resolves HERE without any
 * env rewriting. We accept HTTP CONNECT only, check the target host against
 * FILTER_ALLOW_HOSTS, and relay the raw bytes (including the agent's
 * Proxy-Authorization) to the real gateway, which still authenticates the
 * agent and injects credentials. Anything not allowlisted is refused with
 * a 403 and logged.
 *
 * Fail-closed by construction: no allowlist -> everything refused; proxy
 * down -> the agent has no route at all (internal network, no other hop).
 *
 * Dep-free on purpose (node:net only). Runs under Bun in the agent image:
 *   bun run /filter/filter-proxy.ts
 */
import net from 'node:net';

import { hostAllowed, parseAllowlist, parseConnectTarget } from './allowlist.ts';

const LISTEN_PORT = Number(process.env.FILTER_LISTEN_PORT) || 10255;
const UPSTREAM_HOST = process.env.FILTER_UPSTREAM_HOST || 'onecli';
const UPSTREAM_PORT = Number(process.env.FILTER_UPSTREAM_PORT) || 10255;
const ALLOW_HOSTS = parseAllowlist(process.env.FILTER_ALLOW_HOSTS);
/** Only TLS on 443 is relayed; the gateway's MITM only makes sense there. */
const ALLOWED_PORTS = new Set([443]);

const MAX_HEADER_BYTES = 16 * 1024;
const HEADER_TIMEOUT_MS = 10_000;

function log(kind: 'allow' | 'refuse' | 'error' | 'info', detail: string): void {
  console.log(`${new Date().toISOString()} [${kind}] ${detail}`);
}

function refuse(socket: net.Socket, reason: string): void {
  log('refuse', reason);
  socket.end(
    'HTTP/1.1 403 Forbidden\r\n' +
      'Content-Type: application/json\r\n' +
      'Connection: close\r\n' +
      '\r\n' +
      JSON.stringify({ error: 'egress_denied', message: `NanoClaw egress filter: ${reason}` }) +
      '\n',
  );
}

const server = net.createServer((client) => {
  let buffer = Buffer.alloc(0);
  let done = false;

  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      refuse(client, 'header timeout');
    }
  }, HEADER_TIMEOUT_MS);

  const onData = (chunk: Buffer) => {
    if (done) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_HEADER_BYTES) {
      done = true;
      clearTimeout(timer);
      refuse(client, 'header too large');
      return;
    }

    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    done = true;
    clearTimeout(timer);
    client.off('data', onData);

    const requestLine = buffer.subarray(0, buffer.indexOf('\r\n')).toString('latin1');
    const [method, target] = requestLine.split(' ');

    if (method !== 'CONNECT') {
      refuse(client, `non-CONNECT method ${JSON.stringify(method?.slice(0, 16) ?? '')} (plain HTTP egress is disabled)`);
      return;
    }

    const parsed = target ? parseConnectTarget(target) : null;
    if (!parsed) {
      refuse(client, `unparseable CONNECT target ${JSON.stringify(target?.slice(0, 64) ?? '')}`);
      return;
    }
    if (!ALLOWED_PORTS.has(parsed.port)) {
      refuse(client, `port ${parsed.port} not allowed (443 only): ${parsed.host}`);
      return;
    }
    if (!hostAllowed(parsed.host, ALLOW_HOSTS)) {
      refuse(client, `host not in allowlist: ${parsed.host}`);
      return;
    }

    const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
      log('allow', `${parsed.host}:${parsed.port}`);
      // Replay the buffered bytes (CONNECT line + headers incl.
      // Proxy-Authorization + any early payload), then splice.
      upstream.write(buffer);
      client.pipe(upstream);
      upstream.pipe(client);
    });

    upstream.on('error', (err) => {
      log('error', `upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT} — ${err.message}`);
      client.destroy();
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  };

  client.on('data', onData);
  client.on('error', () => {
    clearTimeout(timer);
  });
});

server.listen(LISTEN_PORT, () => {
  log(
    'info',
    `egress filter listening on :${LISTEN_PORT}, upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT}, allow=[${ALLOW_HOSTS.join(', ')}]`,
  );
  if (ALLOW_HOSTS.length === 0) {
    log('info', 'allowlist is EMPTY — all egress will be refused');
  }
});
