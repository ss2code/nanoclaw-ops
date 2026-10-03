import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { stableActionToken } from './domain.js';
import type { TutorConsoleApi } from './service.js';

const MAX_BODY = 1024 * 1024;

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY) throw new Error('request body is too large');
    chunks.push(value);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object');
  return value as Record<string, unknown>;
}

export function allowedHost(req: Pick<http.IncomingMessage, 'headers'>): boolean {
  const host = (req.headers.host ?? '').split(':')[0].replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function allowedOrigin(req: Pick<http.IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

export function actionAuthorized(req: Pick<http.IncomingMessage, 'headers'>, actionToken: string): boolean {
  return allowedOrigin(req) && req.headers['x-tutor-action-token'] === actionToken;
}

function safeId(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(value)) throw new Error('invalid tutor application id');
  return value;
}

export interface TutorConsoleServerOptions {
  assetsDir: string;
}

export function createTutorConsoleServer(api: TutorConsoleApi, options: TutorConsoleServerOptions): http.Server {
  const actionToken = stableActionToken();

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      if (!allowedHost(req)) return json(res, 403, { error: 'This console accepts loopback requests only.' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(path.join(options.assetsDir, 'index.html'), 'utf8').replace('__ACTION_TOKEN__', actionToken);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
        });
        return res.end(html);
      }
      if (req.method === 'GET' && ['/app.js', '/styles.css'].includes(url.pathname)) {
        const name = url.pathname.slice(1);
        const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        return res.end(fs.readFileSync(path.join(options.assetsDir, name)));
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      if (req.method === 'POST') {
        if (!allowedOrigin(req)) return json(res, 403, { error: 'Cross-origin action rejected.' });
        if (!actionAuthorized(req, actionToken)) return json(res, 403, { error: 'Action token missing or invalid. Refresh the page.' });
      }

      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, 200, await api.bootstrap());
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await api.listStatus());
      const pairingMatch = url.pathname.match(/^\/api\/pairings\/(\d{4})$/);
      if (req.method === 'GET' && pairingMatch) return json(res, 200, await api.pairingStatus(pairingMatch[1]));

      const body = req.method === 'POST' ? await readJson(req) : {};
      if (req.method === 'POST' && url.pathname === '/api/draft') return json(res, 200, await api.saveDraft(body.draft as never));
      if (req.method === 'POST' && url.pathname === '/api/pairings') {
        const role = body.role === 'student' ? 'student' : 'tutor';
        const slot = typeof body.slot === 'string' ? body.slot : undefined;
        return json(res, 200, await api.startPairing(body.draft as never, role, slot));
      }
      if (req.method === 'POST' && url.pathname === '/api/instantiate') return json(res, 200, await api.instantiate(body.draft as never));

      const actionMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/action$/);
      if (req.method === 'POST' && actionMatch) return json(res, 200, await api.classAction(safeId(actionMatch[1]), String(body.action ?? '')));
      const cleanupMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/cleanup$/);
      if (req.method === 'POST' && cleanupMatch) {
        return json(res, 200, await api.cleanup(safeId(cleanupMatch[1]), body.purge === true, String(body.confirmation ?? '')));
      }
      return json(res, 404, { error: 'Unknown API route' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json(res, 400, { error: message.slice(0, 4000) });
    }
  };
  return http.createServer(handler);
}
