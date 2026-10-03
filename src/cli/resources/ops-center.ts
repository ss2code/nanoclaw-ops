import http from 'http';

import { registerResource } from '../crud.js';

const DEFAULT_OPS_CENTER_PORT = 10333;
const OPS_CENTER_TIMEOUT_MS = 5_000;
const OPS_CENTER_MAX_BYTES = 2 * 1024 * 1024;

export interface OpsCenterDomainSnapshot {
  ok: boolean;
  ts?: string;
  live?: unknown;
  apps?: unknown[];
  trips?: unknown[];
}

export function opsCenterCapabilities(): string[] {
  return [
    'List and resolve apps from the NanoClaw app catalog.',
    'Read the Ops Center domain snapshot: host health, channels, queues, app catalog, and Trip Companion summaries.',
    'Use Ops Center first for covered state, then ask the app directly when more detail is needed.',
    'Delegate to registered app agents such as @goa-trip and relay their replies.',
    'Propose catalog or routing changes through the normal approval flow; no direct private DB/file reads.',
  ];
}

function opsCenterPort(): number {
  const raw = process.env.OPS_CENTER_PORT;
  const parsed = raw ? Number(raw) : DEFAULT_OPS_CENTER_PORT;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_OPS_CENTER_PORT;
}

export async function readOpsCenterDomainSnapshot(): Promise<OpsCenterDomainSnapshot> {
  const port = opsCenterPort();
  const body = await httpGetLocalJson(port, '/api/jeeves/domain');
  const parsed = JSON.parse(body) as OpsCenterDomainSnapshot;
  if (!parsed || typeof parsed !== 'object') throw new Error('Ops Center returned a non-object response');
  return parsed;
}

function httpGetLocalJson(port: number, pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          accept: 'application/json',
        },
        timeout: OPS_CENTER_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > OPS_CENTER_MAX_BYTES) {
            req.destroy(new Error('Ops Center response exceeded 2 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Ops Center returned HTTP ${res.statusCode ?? 'unknown'}: ${body.slice(0, 200)}`));
            return;
          }
          resolve(body);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Ops Center did not respond within ${OPS_CENTER_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end();
  });
}

registerResource({
  name: 'ops-center',
  plural: 'ops-center',
  table: '',
  description:
    'Ops Center read bridge — host-mediated, read-only snapshots for Jeeves. Does not expose arbitrary host networking or action APIs.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    domain: {
      access: 'open',
      description:
        'Read the Jeeves domain snapshot from Ops Center: live host/channel/queue health, app catalog, and Trip Companion state.',
      handler: async () => readOpsCenterDomainSnapshot(),
    },
    capabilities: {
      access: 'open',
      description: 'Return a short summary of what Jeeves can do as Chief of Staff.',
      handler: async () => opsCenterCapabilities(),
    },
  },
});
