import { createHash, randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';

export function nowIso(value?: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date: ${value}`);
  return parsed.toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeText(value: string): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function slugify(value: string): string {
  const slug = normalizeText(value).replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80);
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`cannot create slug from ${JSON.stringify(value)}`);
  return slug;
}

export function normalizeTag(value: string): string {
  return slugify(value);
}

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid']);

export function normalizeUrl(value: string): string {
  const parsed = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`unsupported URL scheme: ${parsed.protocol}`);
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
  if (parsed.pathname !== '/' && !parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

export function platformFromUrl(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (host.endsWith('instagram.com')) return 'instagram';
  if (host.endsWith('facebook.com')) return 'facebook';
  if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
  if (host.endsWith('tiktok.com')) return 'tiktok';
  if (host.endsWith('x.com') || host.endsWith('twitter.com')) return 'x';
  if (host.endsWith('maps.google.com') || host.endsWith('google.com')) return 'google-maps';
  if (host.endsWith('openstreetmap.org')) return 'openstreetmap';
  return host;
}

export function assertInside(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`path escapes workspace: ${target}`);
  }
  return resolvedTarget;
}

export function clampConfidence(value: number | undefined): number {
  if (value == null) return 0.5;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('confidence must be between 0 and 1');
  return Math.round(value * 1000) / 1000;
}

export function validateCoordinates(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`invalid latitude: ${lat}`);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error(`invalid longitude: ${lng}`);
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (n: number) => (n * Math.PI) / 180;
  const earth = 6_371_000;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(x));
}

export function tokenSimilarity(a: string, b: string): number {
  const left = new Set(normalizeText(a).split(' ').filter(Boolean));
  const right = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / new Set([...left, ...right]).size;
}

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}
