import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CHARACTERIZATION TESTS (design §6, regression-first).
//
// These drive the REAL CLI (`bun scripts/trip-finance.ts`) and pin its exact
// stdout + exact DB rows for a representative command set. They are written
// BEFORE the trip-core extraction and MUST pass afterward UNEDITED. A test that
// needs changing to go green means the extraction changed behaviour = a
// regression — fix the extraction, never this file.
//
// DB assertions query only the LEGACY columns that exist today, so the suite is
// agnostic to additive columns the extraction introduces (e.g. trip.stage).

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'trip-finance.ts');
const CWD = join(import.meta.dir, '..');

let dir: string;
let DB: string;

function run(...args: string[]): { stdout: string; stderr: string; code: number } {
  const proc = Bun.spawnSync(['bun', SCRIPT, '--db', DB, ...args], {
    cwd: CWD,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    code: proc.exitCode ?? -1,
  };
}

function db(): Database {
  return new Database(DB, { readonly: true });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tf-char-'));
  DB = join(dir, 'trip.db');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CLI characterization — config / roster (the moved surface)', () => {
  test('init prints the confirmation and writes the trip row', () => {
    const r = run('--at', '2026-12-19T09:00:00', 'init', '--name', 'Goa 2026',
      '--base-currency', 'INR', '--start', '2026-12-20', '--end', '2026-12-27',
      '--default-split', 'equal-all');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Trip "Goa 2026" initialized at ${DB}\n`);

    const d = db();
    const trip = d.query(
      'SELECT name, base_currency, start_date, end_date, default_split_rule, status FROM trip WHERE id = 1',
    ).get() as Record<string, unknown>;
    d.close();
    expect(trip).toEqual({
      name: 'Goa 2026',
      base_currency: 'INR',
      start_date: '2026-12-20',
      end_date: '2026-12-27',
      default_split_rule: 'equal-all',
      status: 'active',
    });
  });

  test('add-family prints the id and writes the family row', () => {
    const r1 = run('--at', '2026-12-19T09:05:00', 'add-family', '--name', 'Kapoor');
    expect(r1.stdout).toBe('Family #1: Kapoor\n');
    const r2 = run('--at', '2026-12-19T09:05:01', 'add-family', '--name', 'Iyer');
    expect(r2.stdout).toBe('Family #2: Iyer\n');

    const d = db();
    const fams = d.query('SELECT id, name FROM families ORDER BY id').all();
    d.close();
    expect(fams).toEqual([{ id: 1, name: 'Kapoor' }, { id: 2, name: 'Iyer' }]);
  });

  test('add-member assigns sequential ids; aliases/family/excluded persist exactly', () => {
    expect(run('--at', '2026-12-19T09:10:00', 'add-member', '--name', 'Arjun',
      '--family', '1', '--joined', '2026-12-20').stdout).toBe('Member #1: Arjun\n');
    expect(run('--at', '2026-12-19T09:10:01', 'add-member', '--name', 'Diya',
      '--family', '1', '--aliases', 'pri,p', '--joined', '2026-12-20').stdout).toBe('Member #2: Diya\n');
    expect(run('--at', '2026-12-19T09:10:02', 'add-member', '--name', 'Vik',
      '--family', '2', '--joined', '2026-12-20').stdout).toBe('Member #3: Vik\n');
    expect(run('--at', '2026-12-19T09:10:03', 'add-member', '--name', 'Dev',
      '--joined', '2026-12-20').stdout).toBe('Member #4: Dev\n');
    expect(run('--at', '2026-12-19T09:10:04', 'add-member', '--name', 'Bhola',
      '--joined', '2026-12-20', '--excluded').stdout).toBe('Member #5: Bhola\n');

    const d = db();
    const rows = d.query(
      'SELECT id, display_name, aliases, family_id, platform_id, joined_at, left_at, excluded_from_splits FROM members ORDER BY id',
    ).all();
    d.close();
    expect(rows).toEqual([
      { id: 1, display_name: 'Arjun', aliases: '[]', family_id: 1, platform_id: null, joined_at: '2026-12-20', left_at: null, excluded_from_splits: 0 },
      { id: 2, display_name: 'Diya', aliases: '["pri","p"]', family_id: 1, platform_id: null, joined_at: '2026-12-20', left_at: null, excluded_from_splits: 0 },
      { id: 3, display_name: 'Vik', aliases: '[]', family_id: 2, platform_id: null, joined_at: '2026-12-20', left_at: null, excluded_from_splits: 0 },
      { id: 4, display_name: 'Dev', aliases: '[]', family_id: null, platform_id: null, joined_at: '2026-12-20', left_at: null, excluded_from_splits: 0 },
      { id: 5, display_name: 'Bhola', aliases: '[]', family_id: null, platform_id: null, joined_at: '2026-12-20', left_at: null, excluded_from_splits: 1 },
    ]);
  });

  test('set-member updates aliases in place and journals it', () => {
    const r = run('--at', '2026-12-19T09:11:00', 'set-member', '2', '--aliases', 'diya,pri');
    expect(r.stdout).toBe('Member #2 updated\n');
    const d = db();
    const m = d.query('SELECT aliases FROM members WHERE id = 2').get() as { aliases: string };
    d.close();
    expect(m.aliases).toBe('["diya","pri"]');
  });

  test('members renders the exact roster listing', () => {
    expect(run('members').stdout).toBe(
      '#1 Arjun · family 1\n' +
      '#2 Diya · family 1\n' +
      '#3 Vik · family 2\n' +
      '#4 Dev · standalone\n' +
      '#5 Bhola · standalone · EXCLUDED from splits\n',
    );
  });

  test('families renders the exact listing', () => {
    expect(run('families').stdout).toBe('#1 Kapoor\n#2 Iyer\n');
  });
});

describe('CLI characterization — ledger / reports', () => {
  test('log equal-all prints per-person shares', () => {
    const r = run('--at', '2026-12-20T10:00:00', 'log', '--desc', 'Hotel',
      '--amount', '40000', '--currency', 'INR', '--payer', '1', '--rule', 'equal-all', '--by', '1');
    // Bhola is excluded, so 4 participants split ₹40,000.
    expect(r.stdout).toBe(
      '✓ Logged expense #1\n' +
      '  Arjun: ₹10,000.00\n' +
      '  Diya: ₹10,000.00\n' +
      '  Vik: ₹10,000.00\n' +
      '  Dev: ₹10,000.00\n',
    );
  });

  test('log by-family splits by unit', () => {
    const r = run('--at', '2026-12-20T13:00:00', 'log', '--desc', 'Lunch',
      '--amount', '4800', '--currency', 'INR', '--payer', '2', '--rule', 'by-family', '--by', '2');
    // 3 units (Kapoor, Iyer, Dev-standalone) → ₹1,600 each; Kapoor's ₹1,600 splits 800/800.
    expect(r.stdout).toBe(
      '✓ Logged expense #2\n' +
      '  Arjun: ₹800.00\n' +
      '  Diya: ₹800.00\n' +
      '  Vik: ₹1,600.00\n' +
      '  Dev: ₹1,600.00\n',
    );
  });

  test('log custom exclude with crumb absorbed by payer', () => {
    const r = run('--at', '2026-12-20T15:00:00', 'log', '--desc', 'Sports',
      '--amount', '7000', '--currency', 'INR', '--payer', '1', '--rule', 'custom',
      '--custom', '{"kind":"exclude","memberIds":[3]}', '--by', '1');
    // Exclude Vik(3): 3 remaining split ₹7,000 → payer Arjun absorbs the +1 paise.
    expect(r.stdout).toBe(
      '✓ Logged expense #3\n' +
      '  Arjun: ₹2,333.34\n' +
      '  Diya: ₹2,333.33\n' +
      '  Dev: ₹2,333.33\n',
    );
  });

  test('expense <id> shows the expense with shares', () => {
    expect(run('expense', '1').stdout).toBe(
      '#1 Hotel · ₹40,000.00 · paid by Arjun · equal-all\n' +
      '  Arjun: ₹10,000.00\n' +
      '  Diya: ₹10,000.00\n' +
      '  Vik: ₹10,000.00\n' +
      '  Dev: ₹10,000.00\n',
    );
  });

  test('expenses lists all in descending-then-reversed order', () => {
    expect(run('expenses').stdout).toBe(
      '#1 Hotel · ₹40,000.00 · paid by Arjun · equal-all\n' +
      '#2 Lunch · ₹4,800.00 · paid by Diya · by-family\n' +
      '#3 Sports · ₹7,000.00 · paid by Arjun · custom\n',
    );
  });

  test('edit and void print confirmations and mutate state', () => {
    expect(run('--at', '2026-12-21T09:00:00', 'edit', '1', '--amount', '41000', '--actor', '1').stdout)
      .toBe('✓ Edited expense #1\n');
    expect(run('--at', '2026-12-21T09:30:00', 'void', '3', '--actor', '1').stdout)
      .toBe('✓ Voided expense #3\n');
    const d = db();
    const e1 = d.query('SELECT amount FROM expenses WHERE id = 1').get() as { amount: number };
    const e3 = d.query('SELECT voided_at FROM expenses WHERE id = 3').get() as { voided_at: string | null };
    d.close();
    expect(e1.amount).toBe(4_100_000);
    expect(e3.voided_at).not.toBeNull();
  });

  test('settlement prints confirmation and writes the row', () => {
    expect(run('--at', '2026-12-21T10:00:00', 'settlement', '--from', '2', '--to', '1',
      '--amount', '1000', '--currency', 'INR', '--by', '2').stdout).toBe('✓ Settlement #1 recorded\n');
  });

  test('balance renders per-currency nets', () => {
    expect(run('balance').stdout).toBe(
      'INR:\n' +
      '  Arjun: is owed ₹28,950.00\n' +
      '  Diya: owes ₹5,250.00\n' +
      '  Vik: owes ₹11,850.00\n' +
      '  Dev: owes ₹11,850.00\n',
    );
  });

  test('settle renders the minimal transfer plan', () => {
    expect(run('settle').stdout).toBe(
      'INR — 3 transfer(s):\n' +
      '  Vik → Arjun: ₹11,850.00\n' +
      '  Dev → Arjun: ₹11,850.00\n' +
      '  Diya → Arjun: ₹5,250.00\n',
    );
  });

  test('status renders the trip summary line', () => {
    expect(run('status').stdout).toBe(
      'Trip: Goa 2026 (active) · base INR\n' +
      'Members: 5 · Expenses: 2 active, 1 voided · Settlements: 1\n',
    );
  });

  test('journal renders the audit trail with actor names', () => {
    // 9 config rows (init + 2 families + 5 members + 1 set-member), then the
    // custom log (#12), edit (#13), void (#14), settlement (#15).
    expect(run('journal', '--limit', '4').stdout).toBe(
      '#12 2026-12-20T15:00:00 Arjun expense.log expense:3\n' +
      '#13 2026-12-21T09:00:00 Arjun expense.edit expense:1\n' +
      '#14 2026-12-21T09:30:00 Arjun expense.void expense:3\n' +
      '#15 2026-12-21T10:00:00 Diya settlement.log settlement:1\n',
    );
  });
});

describe('CLI characterization — constants & error paths', () => {
  test('help renders the full reference and exits 0', () => {
    const r = run('help');
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('trip-finance — deterministic trip ledger\n')).toBe(true);
    expect(r.stdout).toContain('Global:  --db <path>');
    expect(r.stdout).toContain('Config   init');
    expect(r.stdout).toContain('Ledger   log');
    expect(r.stdout).toContain('Custom split spec (JSON):');
  });

  test('unknown command writes to stderr and exits 1', () => {
    const r = run('frobnicate');
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('error: unknown command "frobnicate" — run `trip-finance help`\n');
  });

  test('balance --consolidate folds at an explicit rate', () => {
    // Fresh DB for an isolated USD scenario.
    const isolated = mkdtempSync(join(tmpdir(), 'tf-char-iso-'));
    const prevDB = DB;
    DB = join(isolated, 'trip.db');
    try {
      run('--at', '2026-12-19T09:00:00', 'init', '--name', 'T', '--base-currency', 'INR');
      run('add-member', '--name', 'A', '--joined', '2026-12-20');
      run('add-member', '--name', 'B', '--joined', '2026-12-20');
      run('--at', '2026-12-20T10:00:00', 'log', '--desc', 'X', '--amount', '200',
        '--currency', 'USD', '--payer', '1', '--rule', 'equal-all', '--by', '1');
      const r = run('--at', '2026-12-21T00:00:00', 'balance', '--consolidate', 'USD=84');
      expect(r.stdout).toBe(
        'Consolidated into INR at explicit rates USD=84 (journaled):\n' +
        '  A: is owed ₹8,400.00\n' +
        '  B: owes ₹8,400.00\n',
      );
    } finally {
      DB = prevDB;
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
