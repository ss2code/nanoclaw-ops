import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class TutorError extends Error {
  constructor(message: string, readonly exitCode: number = 1) {
    super(message);
  }
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(parts.join('\u001f')).slice(0, 20)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function now(): string {
  if (process.env.TUTOR_HARNESS === '1' && process.env.TUTOR_NOW) {
    const value = new Date(process.env.TUTOR_NOW);
    if (Number.isNaN(value.getTime())) throw new TutorError('TUTOR_NOW must be an ISO date in the test harness', 64);
    return value.toISOString();
  }
  return new Date().toISOString();
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function stripTags(value: string): string {
  return normalizeText(value.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

export function requiredFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') throw new TutorError(`--${name} is required`, 64);
  return value;
}

/** Validate a command's complete required-flag set in one pass. */
export function requiredFlags(
  flags: Record<string, string | boolean>,
  names: readonly string[],
): Record<string, string> {
  const missing = names.filter((name) => typeof flags[name] !== 'string' || !String(flags[name]).trim());
  if (missing.length) throw new TutorError(`required flags: ${missing.map((name) => `--${name}`).join(', ')}`, 64);
  return Object.fromEntries(names.map((name) => [name, String(flags[name])])) as Record<string, string>;
}

export function optionalFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function assertNoTargetFlags(flags: Record<string, string | boolean>): void {
  for (const forbidden of ['student', 'student-id', 'root', 'db', 'path', 'routing']) {
    if (forbidden in flags) throw new TutorError(`unsupported target argument --${forbidden}`, 64);
  }
}

export function appRoot(): string {
  if (process.env.TUTOR_HARNESS === '1') {
    const root = process.env.TUTOR_APP_ROOT;
    if (!root || !fs.existsSync(path.join(root, '.tutor-test-world'))) {
      throw new TutorError('invalid tutor harness root', 77);
    }
    return path.resolve(root);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function inboundDbPath(): string {
  if (process.env.TUTOR_HARNESS === '1') {
    const db = process.env.TUTOR_INBOUND_DB;
    if (!db) throw new TutorError('missing tutor harness routing database', 77);
    return path.resolve(db);
  }
  return '/workspace/inbound.db';
}

export function emit(value: unknown, json: boolean, receipt?: string): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (receipt) console.log(receipt);
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export function bandRank(band: string): number {
  return band === 'high' ? 3 : band === 'medium' ? 2 : 1;
}

export function canonicalDifficulty(value: string | undefined): 'low' | 'medium' | 'high' | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['easy', 'low', 'recall'].includes(normalized)) return 'low';
  if (['medium', 'moderate', 'comprehension'].includes(normalized)) return 'medium';
  if (['difficult', 'hard', 'high', 'application'].includes(normalized)) return 'high';
  return null;
}
