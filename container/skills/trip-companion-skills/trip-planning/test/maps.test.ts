import { describe, expect, test } from 'bun:test';
import { MapsClient, parseDurationMinutes } from '../scripts/maps';
import { checkUrls } from '../scripts/links';

describe('Maps travel-times (§7, §22.4 — flag unknown, never invent)', () => {
  test('parseDurationMinutes reads Google Directions duration (seconds → minutes)', () => {
    const resp = { routes: [{ legs: [{ duration: { value: 2400 } }] }] };
    expect(parseDurationMinutes(resp)).toBe(40);
  });

  test('parseDurationMinutes returns null on an empty/!ok response (so the caller flags unknown)', () => {
    expect(parseDurationMinutes({ routes: [] })).toBeNull();
    expect(parseDurationMinutes(null)).toBeNull();
  });

  test('MapsClient caches by (from,to,mode) — the directions fn is called once', async () => {
    let calls = 0;
    const client = new MapsClient(async () => {
      calls++;
      return { routes: [{ legs: [{ duration: { value: 1500 } }] }] };
    });
    expect(await client.travelMinutes(1, 2, 'driving')).toBe(25);
    expect(await client.travelMinutes(1, 2, 'driving')).toBe(25); // cache hit
    expect(calls).toBe(1);
    // a different mode is a different key
    await client.travelMinutes(1, 2, 'walking');
    expect(calls).toBe(2);
  });

  test('MapsClient returns null (flag unknown) when the API errors — it never invents a duration', async () => {
    const client = new MapsClient(async () => {
      throw new Error('429 rate limited');
    });
    expect(await client.travelMinutes(1, 2, 'driving')).toBeNull();
  });
});

describe('URL-validity gate (§10, Gate 2)', () => {
  test('checkUrls returns ok for 2xx and not-ok for non-2xx / errors', async () => {
    const fetcher = async (url: string) => {
      if (url.includes('good')) return { ok: true, status: 200 };
      if (url.includes('notfound')) return { ok: false, status: 404 };
      throw new Error('network down');
    };
    const r = await checkUrls(['https://good/a', 'https://notfound/b', 'https://dead/c'], fetcher);
    expect(r.find((x) => x.url.includes('good'))!.ok).toBe(true);
    expect(r.find((x) => x.url.includes('notfound'))!.ok).toBe(false);
    expect(r.find((x) => x.url.includes('notfound'))!.status).toBe(404);
    expect(r.find((x) => x.url.includes('dead'))!.ok).toBe(false);
  });

  test('checkUrls dedupes repeated URLs', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { ok: true, status: 200 };
    };
    await checkUrls(['https://x/1', 'https://x/1', 'https://x/2'], fetcher);
    expect(calls).toBe(2);
  });
});
