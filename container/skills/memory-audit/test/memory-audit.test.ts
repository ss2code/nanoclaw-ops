import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDb } from '../../memory/scripts/db';
import { remember } from '../../memory/scripts/store';

let dir: string;
const NOW = '2026-07-10T00:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-audit-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  return Bun.spawnSync(['bun', join(import.meta.dir, '../scripts/memory-audit.ts'), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

test('eval passes against an expected memory without reinforcing live access counts', () => {
  const dbPath = join(dir, 'memory.db');
  const cfgPath = join(dir, 'memory.config.json');
  const suitePath = join(dir, 'memory-evals.json');
  writeFileSync(cfgPath, JSON.stringify({ scope: 'group:test', retrieval: { k: 5 }, approval: { required: true, owner: 'Alice' } }));
  const db = openMemoryDb(dbPath, { defaultScope: 'group:test' });
  remember(db, {
    scope: 'group:test',
    title: 'Memory evaluation canary',
    content: 'The canary proves recall quality can be measured without mutating access_count.',
    importance: 4,
  }, NOW);
  db.close();
  writeFileSync(suitePath, JSON.stringify({ cases: [{ name: 'canary', query: 'canary recall quality', expectAny: ['Memory evaluation canary'] }] }));

  const proc = run(['--db', dbPath, '--config', cfgPath, 'eval', '--suite', suitePath, '--json']);
  expect(proc.exitCode).toBe(0);
  const out = JSON.parse(proc.stdout.toString());
  expect(out.status).toBe('pass');

  const check = openMemoryDb(dbPath, { defaultScope: 'group:test' });
  const row = check.query('SELECT access_count FROM memories WHERE title=$t').get({ $t: 'Memory evaluation canary' }) as { access_count: number };
  expect(row.access_count).toBe(0);
  check.close();
});

test('health warns when reflection is manual and owner is not materialized', () => {
  const dbPath = join(dir, 'memory.db');
  const cfgPath = join(dir, 'memory.config.json');
  writeFileSync(cfgPath, JSON.stringify({ scope: 'group:test', reflection: { cadence: 'manual' }, approval: { required: true, owner: 'Alice' } }));
  openMemoryDb(dbPath, { defaultScope: 'group:test' }).close();

  const proc = run(['--db', dbPath, '--config', cfgPath, 'health', '--json']);
  expect(proc.exitCode).toBe(0);
  const out = JSON.parse(proc.stdout.toString());
  expect(out.status).toBe('warn');
  expect(out.issues.map((i: { code: string }) => i.code)).toContain('approval_owner_not_materialized');
  expect(out.issues.map((i: { code: string }) => i.code)).toContain('reflection_manual');
});

test('eval distinguishes a retired expectation from a live retrieval failure', () => {
  const dbPath = join(dir, 'memory.db');
  const cfgPath = join(dir, 'memory.config.json');
  const suitePath = join(dir, 'memory-evals.json');
  writeFileSync(cfgPath, JSON.stringify({ scope: 'group:test' }));
  openMemoryDb(dbPath, { defaultScope: 'group:test' }).close();
  writeFileSync(
    suitePath,
    JSON.stringify({ cases: [{ name: 'retired canary', query: 'retired canary', expectAny: ['No longer stored'] }] }),
  );

  const proc = run(['--db', dbPath, '--config', cfgPath, 'eval', '--suite', suitePath, '--json']);
  expect(proc.exitCode).toBe(0);
  const out = JSON.parse(proc.stdout.toString());
  expect(out.status).toBe('warn');
  expect(out.staleCases).toEqual(['retired canary']);
  expect(out.results[0]).toMatchObject({ passed: false, stale: true, missingExpected: ['No longer stored'] });
});

test('health distinguishes an available archive from complete review coverage', () => {
  const dbPath = join(dir, 'memory.db');
  const cfgPath = join(dir, 'memory.config.json');
  const inboundPath = join(dir, 'inbound.db');
  const conversationDir = join(dir, 'conversations');
  writeFileSync(cfgPath, JSON.stringify({ scope: 'group:test' }));
  openMemoryDb(dbPath, { defaultScope: 'group:test' }).close();
  const inbound = new Database(inboundPath);
  inbound.exec(`
    CREATE TABLE messages_in (id TEXT, kind TEXT, timestamp TEXT, content TEXT);
    INSERT INTO messages_in VALUES ('m1', 'chat', datetime('now'), '{"text":"recent fact"}');
  `);
  inbound.close();
  mkdirSync(conversationDir, { recursive: true });
  Bun.write(join(conversationDir, '2026-08-09-conversation.md'), '# Conversation\n');

  const proc = run([
    '--db',
    dbPath,
    '--config',
    cfgPath,
    '--inbound',
    inboundPath,
    '--conversations',
    conversationDir,
    'health',
    '--json',
  ]);
  expect(proc.exitCode).toBe(0);
  const out = JSON.parse(proc.stdout.toString());
  expect(out.reviewEvidence).toMatchObject({ archiveAvailable: true, currentSessionOnly: false, archivedFileCount: 1 });
  expect(out.issues.map((i: { code: string }) => i.code)).toContain('review_source_partial');
});

test('health does not treat a session-local schedule view as proof that review is absent', () => {
  const dbPath = join(dir, 'memory.db');
  const cfgPath = join(dir, 'memory.config.json');
  const inboundPath = join(dir, 'inbound.db');
  writeFileSync(cfgPath, JSON.stringify({ scope: 'group:test' }));
  openMemoryDb(dbPath, { defaultScope: 'group:test' }).close();
  const inbound = new Database(inboundPath);
  inbound.exec(`
    CREATE TABLE messages_in (id TEXT, kind TEXT, timestamp TEXT, content TEXT);
    INSERT INTO messages_in VALUES ('m1', 'chat', datetime('now'), '{"text":"recent fact"}');
  `);
  inbound.close();

  const proc = run([
    '--db',
    dbPath,
    '--config',
    cfgPath,
    '--inbound',
    inboundPath,
    'health',
    '--json',
  ]);
  expect(proc.exitCode).toBe(0);
  const out = JSON.parse(proc.stdout.toString());
  const codes = out.issues.map((i: { code: string }) => i.code);
  expect(codes).not.toContain('no_current_recurring_review');
  expect(codes).toContain('review_schedule_unverified');
  expect(out.reviewEvidence).toMatchObject({ scheduleScope: 'session' });
});
