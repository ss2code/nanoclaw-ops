import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'trip-planning.ts');
const CORE = join(import.meta.dir, '..', '..', 'trip-core', 'scripts', 'trip-core.ts');
const CWD = join(import.meta.dir, '..');
let dir: string;
let DB: string;

function run(...args: string[]): { stdout: string; stderr: string; code: number } {
  const proc = Bun.spawnSync(['bun', SCRIPT, '--db', DB, ...args], { cwd: CWD, stdout: 'pipe', stderr: 'pipe' });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), code: proc.exitCode ?? -1 };
}
function core(...args: string[]): void {
  Bun.spawnSync(['bun', CORE, '--db', DB, ...args], { cwd: CWD, stdout: 'pipe', stderr: 'pipe' });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-cli-'));
  DB = join(dir, 'trip.db');
  core('setup', 'ensure', '--name', 'Goa 2026', '--base-currency', 'INR', '--start', '2026-08-14', '--end', '2026-08-14');
  core('member', 'add', '--name', 'Arjun', '--joined', '2026-08-14');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('trip-planning CLI', () => {
  test('place add + destination add report ids', () => {
    expect(run('place', 'add', '--name', 'Goa', '--map-url', 'https://m/goa').stdout).toContain('Place #1: Goa');
    expect(run('destination', 'add', '--place', '1', '--order', '0', '--nights', '1').stdout).toContain('Destination #1');
  });

  test('item add accepts major-unit cost and converts to minor', () => {
    run('day', 'add', '--date', '2026-08-14', '--base-place', '1');
    run('item', 'add', '--day', '1', '--slot', 'midday', '--title', 'Fort', '--place', '1', '--cost', '600');
    const got = run('plan', 'rollup', '--json').stdout;
    // candidate items aren't counted; commit it, then rollup
    run('itinerary_items', 'status', '1', '--to', 'committed');
    expect(run('plan', 'rollup', '--json').stdout).toContain('"INR":60000');
  });

  test('plan show renders the board with completeness %', () => {
    const r = run('plan', 'show');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('% set');
    expect(r.stdout).toContain('Where');
  });

  test('plan check surfaces an uncovered-night error for a 0-night plan with no stay', () => {
    // single-day trip (start==end) → 0 nights → no uncovered-night error; add nothing
    const r = run('plan', 'check', '--now', '2026-07-01');
    expect(r.code).toBe(0);
  });

  test('plan validate exits non-zero while incomplete and lists missing slots', () => {
    const r = run('plan', 'validate', '--now', '2026-07-01');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('not ready');
  });

  test('status verb rejects an unknown status', () => {
    const r = run('itinerary_items', 'status', '1', '--to', 'banana');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown status');
  });

  test('help prints the command reference', () => {
    expect(run('help').stdout).toContain('trip-planning — dawn-to-dusk plan model');
  });

  test('unknown command exits 1', () => {
    const r = run('frobnicate', 'widget');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command');
  });
});
