import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'trip-core.ts');
const CWD = join(import.meta.dir, '..');
let dir: string;
let DB: string;

function run(...args: string[]): { stdout: string; stderr: string; code: number } {
  const proc = Bun.spawnSync(['bun', SCRIPT, '--db', DB, ...args], { cwd: CWD, stdout: 'pipe', stderr: 'pipe' });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), code: proc.exitCode ?? -1 };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-cli-'));
  DB = join(dir, 'trip.db');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('trip-core CLI', () => {
  test('setup ensure configures the trip and reports the stage', () => {
    const r = run('--at', '2026-01-01T00:00:00', 'setup', 'ensure', '--name', 'Goa 2026', '--base-currency', 'INR');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('trip-core ready · stage planning\n');
  });

  test('member add / family add / member list', () => {
    expect(run('--at', '2026-01-01T00:01:00', 'family', 'add', '--name', 'Kapoor').stdout).toBe('Family #1: Kapoor\n');
    expect(
      run('--at', '2026-01-01T00:02:00', 'member', 'add', '--name', 'Arjun', '--family', '1', '--joined', '2026-01-01')
        .stdout,
    ).toBe('Member #1: Arjun\n');
    run('--at', '2026-01-01T00:02:01', 'member', 'add', '--name', 'Maya', '--joined', '2026-01-01');
    expect(run('member', 'set', '2', '--platform', 'whatsapp:15550000005@s.whatsapp.net').stdout).toBe(
      'Member #2 updated\n',
    );
    expect(run('member', 'list').stdout).toBe('#1 Arjun · family 1\n#2 Maya · standalone\n');
    expect(run('member', 'mentions').stdout).toBe('#1 Arjun → (no WhatsApp platform id)\n#2 Maya → @15550000005\n');
  });

  test('participation set + show', () => {
    run(
      '--at',
      '2026-01-02T00:00:00',
      '--by',
      '1',
      'participation',
      'set',
      '--member',
      '1',
      '--stage',
      'planning',
      '--status',
      'in',
    );
    run(
      '--at',
      '2026-01-02T00:00:01',
      '--by',
      '1',
      'participation',
      'set',
      '--member',
      '2',
      '--stage',
      'planning',
      '--status',
      'in',
    );
    expect(run('participation', 'show', '--stage', 'planning').stdout).toBe('Arjun [in]\nMaya [in]\n');
  });

  test('lifecycle: propose is non-mutating; confirm advances; regress steps back', () => {
    expect(run('stage', 'show').stdout).toBe('Stage: planning · legal next: plan_ready, cancelled\n');
    const prop = run('--by', '1', 'stage', 'propose', '--to', 'plan_ready');
    expect(prop.stdout).toContain('Proposed planning → plan_ready (legal)');
    expect(run('stage', 'show').stdout).toContain('Stage: planning'); // unchanged by propose
    expect(run('--at', '2026-02-01T00:00:00', '--by', '1', 'stage', 'confirm', '--to', 'plan_ready').stdout).toBe(
      '✓ Stage → plan_ready\n',
    );
    expect(run('--at', '2026-02-02T00:00:00', '--by', '1', 'stage', 'regress').stdout).toBe(
      '✓ Regressed to planning\n',
    );
  });

  test('illegal transition exits 1 with an error', () => {
    const r = run('--by', '1', 'stage', 'confirm', '--to', 'on_trip');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('illegal transition');
  });

  test('decisions: open poll, vote, tally, close', () => {
    run(
      '--at',
      '2026-01-03T00:00:00',
      '--by',
      '1',
      'decision',
      'open',
      '--question',
      'Where?',
      '--mode',
      'poll',
      '--options',
      'Goa|Gokarna',
      '--stage',
      'planning',
    );
    run('--at', '2026-01-03T00:01:00', 'decision', 'vote', '--id', '1', '--member', '1', '--choice', 'Goa');
    run('--at', '2026-01-03T00:02:00', 'decision', 'vote', '--id', '1', '--member', '2', '--choice', 'Goa');
    expect(run('decision', 'tally', '1').stdout).toBe('Tally: Goa 2 · leading: Goa\n');
    expect(run('--at', '2026-01-03T01:00:00', 'decision', 'close', '1', '--outcome', 'Goa').stdout).toBe(
      '✓ Decision #1 closed → Goa\n',
    );
  });

  test('recap renders the current grounded state', () => {
    const r = run('recap');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Stage: planning');
    expect(r.stdout).toContain('Roster (planning): Arjun [in], Maya [in]');
    expect(r.stdout).toContain('Maya: @15550000005');
    expect(r.stdout).toContain('✅ Where? → Goa');
  });

  test('help renders a stage-aware capability menu', () => {
    const r = run('help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Current stage: planning');
    expect(r.stdout).toContain('recap —');
    expect(r.stdout).toContain('decision —');
  });

  test('unknown command exits 1', () => {
    const r = run('frobnicate', 'widget');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command "frobnicate widget"');
  });
});
