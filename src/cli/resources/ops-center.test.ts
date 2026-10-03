import http from 'http';
import { EventEmitter } from 'events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../dispatch.js';
import './ops-center.js';

function mockOpsCenterResponse(payload: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(http, 'request').mockImplementation((options, callback) => {
    const onResponse = callback as ((res: http.IncomingMessage) => void) | undefined;
    expect(options).toMatchObject({
      host: '127.0.0.1',
      path: '/api/jeeves/domain',
      method: 'GET',
    });

    const req = new EventEmitter() as http.ClientRequest;
    req.end = (() => {
      const res = new EventEmitter() as http.IncomingMessage;
      res.statusCode = 200;
      onResponse?.(res);
      queueMicrotask(() => {
        res.emit('data', Buffer.from(JSON.stringify(payload)));
        res.emit('end');
      });
      return req;
    }) as http.ClientRequest['end'];
    req.destroy = (() => req) as http.ClientRequest['destroy'];
    req.setTimeout = (() => req) as http.ClientRequest['setTimeout'];
    return req;
  });
}

describe('ops-center CLI bridge', () => {
  const originalPort = process.env.OPS_CENTER_PORT;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPort === undefined) delete process.env.OPS_CENTER_PORT;
    else process.env.OPS_CENTER_PORT = originalPort;
  });

  it('returns a concise Chief of Staff capability list', async () => {
    const resp = await dispatch(
      { id: 'req-capabilities', command: 'ops-center-capabilities', args: {} },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.data).toEqual(
        expect.arrayContaining([
          expect.stringContaining('app catalog'),
          expect.stringContaining('Ops Center domain snapshot'),
          expect.stringContaining('normal approval flow'),
        ]),
      );
    }
  });

  it('fetches the Jeeves domain snapshot through the host-local Ops Center endpoint', async () => {
    const payload = {
      ok: true,
      ts: '2026-06-29T00:00:00.000Z',
      live: { host: { ok: true } },
      apps: [{ handle: 'goa-trip', name: 'Trip Goa' }],
      trips: [{ name: 'Trip Goa' }],
    };
    process.env.OPS_CENTER_PORT = '43123';
    mockOpsCenterResponse(payload);

    const resp = await dispatch({ id: 'req-domain', command: 'ops-center-domain', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data).toEqual(payload);
  });
});
