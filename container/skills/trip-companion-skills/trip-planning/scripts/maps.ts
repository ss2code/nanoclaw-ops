// Google Maps travel-times (§7). Deterministic given place ids. Credential is
// OneCLI-managed (injected at request time, like add-gcal-tool) — the directions
// function passed in is the seam where the real proxied call lives, so this
// module is unit-testable with a stub. FALLBACK (open item §22.4): on any error
// or empty response, return null so the caller FLAGS an unknown duration rather
// than inventing one (§10 — the script computes; it never guesses).

export interface DirectionsResponse {
  routes?: { legs?: { duration?: { value?: number } }[] }[];
}

/** Total route duration in whole minutes, or null if the response can't be read. */
export function parseDurationMinutes(resp: DirectionsResponse | null): number | null {
  const legs = resp?.routes?.[0]?.legs;
  if (!legs || legs.length === 0) return null;
  let seconds = 0;
  for (const leg of legs) {
    const v = leg.duration?.value;
    if (typeof v !== 'number') return null;
    seconds += v;
  }
  return Math.round(seconds / 60);
}

export type DirectionsFn = (fromPlaceId: number, toPlaceId: number, mode: string) => Promise<DirectionsResponse | null>;

export class MapsClient {
  private cache = new Map<string, number | null>();
  constructor(private directions: DirectionsFn) {}

  /** Travel minutes between two place ids for a mode, cached. null = flag unknown. */
  async travelMinutes(fromPlaceId: number, toPlaceId: number, mode = 'driving'): Promise<number | null> {
    const key = `${fromPlaceId}|${toPlaceId}|${mode}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    let minutes: number | null;
    try {
      minutes = parseDurationMinutes(await this.directions(fromPlaceId, toPlaceId, mode));
    } catch {
      minutes = null; // API/network error → flag unknown, never invent
    }
    this.cache.set(key, minutes);
    return minutes;
  }
}
