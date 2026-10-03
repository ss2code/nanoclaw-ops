import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('place-board CLI', () => {
  test('initializes, ingests, searches, and renders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-places-cli-'));
    dirs.push(dir);
    const input = join(dir, 'input.json');
    writeFileSync(input, JSON.stringify({
      ingestVersion: 1,
      idempotencyKey: 'cli:1',
      member: { localId: 'member', displayAlias: 'Sam' },
      places: [{ name: 'Tilden Regional Park', locality: 'Berkeley', categories: ['hiking'] }],
    }));
    const script = resolve(import.meta.dir, '..', 'scripts', 'place-board.ts');
    const run = (...args: string[]) => Bun.spawnSync(['bun', script, '--dir', dir, ...args]);

    expect(run('init').exitCode).toBe(0);
    const ingest = run('ingest', '--json', input);
    expect(ingest.exitCode).toBe(0);
    expect(JSON.parse(ingest.stdout.toString()).affectedRegions).toEqual(['bay-area']);
    const handoff = join(dir, 'handoff.json');
    const createdHandoff = run(
      'handoff', 'create', '--json', input, '--out', handoff,
      '--message-id', 'whatsapp-message-1', '--channel', 'whatsapp',
      '--delegated-by', 'jeeves', '--researched-by', 'errand-runner',
    );
    expect(createdHandoff.exitCode).toBe(0);
    expect(run('handoff', 'validate', '--json', handoff).exitCode).toBe(0);
    const reingest = run('ingest', '--json', handoff, '--reingest');
    expect(reingest.exitCode).toBe(0);
    expect(JSON.parse(reingest.stdout.toString()).mutations[0].status).toBe('updated');
    const search = run('search', '--query', 'tilden', '--region', 'bay-area');
    expect(JSON.parse(search.stdout.toString())[0].name).toBe('Tilden Regional Park');
    const render = run('render', '--region', 'bay-area');
    expect(JSON.parse(render.stdout.toString()).places).toBe(1);
  });
});
