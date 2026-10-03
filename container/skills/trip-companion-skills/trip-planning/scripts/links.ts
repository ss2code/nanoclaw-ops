import type { Database } from 'bun:sqlite';

// URL-validity gate (§10, Gate 2): every proposed link must return 2xx. Run at
// generation and in CI — dead links can't ship. The fetcher is injectable so the
// logic is unit-testable; the CLI/eval wires it to a real HEAD/GET with timeout.

export interface UrlResult {
  url: string;
  ok: boolean;
  status: number | null;
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number }>;

/** Check a list of URLs (deduped). An error or non-2xx → ok:false. */
export async function checkUrls(urls: string[], fetcher: Fetcher): Promise<UrlResult[]> {
  const unique = [...new Set(urls.filter(Boolean))];
  const out: UrlResult[] = [];
  for (const url of unique) {
    try {
      const r = await fetcher(url);
      out.push({ url, ok: r.ok && r.status >= 200 && r.status < 300, status: r.status });
    } catch {
      out.push({ url, ok: false, status: null });
    }
  }
  return out;
}

/** Gather every link column across the plan tables. */
export function collectPlanUrls(db: Database): string[] {
  const urls: string[] = [];
  const add = (sql: string, col: string) => {
    for (const r of db.query(sql).all() as Record<string, string | null>[]) if (r[col]) urls.push(r[col] as string);
  };
  add('SELECT map_url FROM places WHERE map_url IS NOT NULL', 'map_url');
  add('SELECT booking_url FROM legs WHERE booking_url IS NOT NULL', 'booking_url');
  add('SELECT booking_url FROM transport_hops WHERE booking_url IS NOT NULL', 'booking_url');
  add('SELECT booking_url FROM stays WHERE booking_url IS NOT NULL', 'booking_url');
  add('SELECT booking_url FROM itinerary_items WHERE booking_url IS NOT NULL', 'booking_url');
  add('SELECT info_url FROM itinerary_items WHERE info_url IS NOT NULL', 'info_url');
  add('SELECT url FROM meals WHERE url IS NOT NULL', 'url');
  add('SELECT source_url FROM events WHERE source_url IS NOT NULL', 'source_url');
  return urls;
}

/** Default real fetcher: HEAD with a timeout, falling back to GET (some hosts reject HEAD). */
export async function httpFetcher(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number }> {
  const attempt = async (method: string) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, signal: ctrl.signal, redirect: 'follow' });
      return { ok: res.ok, status: res.status };
    } finally {
      clearTimeout(t);
    }
  };
  try {
    const head = await attempt('HEAD');
    if (head.status >= 200 && head.status < 300) return head;
    return await attempt('GET'); // some hosts 405 HEAD but 200 GET
  } catch {
    return await attempt('GET');
  }
}
