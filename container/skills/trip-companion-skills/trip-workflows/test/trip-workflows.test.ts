import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'trip-workflows.ts');
const CWD = join(import.meta.dir, '..');

function run(...args: string[]): { stdout: string; stderr: string; code: number } {
  const proc = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd: CWD, stdout: 'pipe', stderr: 'pipe' });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), code: proc.exitCode ?? -1 };
}

function json<T>(...args: string[]): T {
  const r = run(...args);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as T;
}

describe('trip-workflows', () => {
  test('builds a Trip Goa vendor solicitation payload', () => {
    const payload = json<{
      tripId: string;
      recipient: string;
      missingInfo: string[];
      replyDeadlineHours: number;
      gmailDestination: string;
    }>(
      'vendor',
      'payload',
      '--trip-id',
      'trip-goa',
      '--recipient',
      'reservations@example-hotel.com',
      '--recipient-label',
      'Example Hotel reservations',
      '--missing',
      'confirmation number,check-in time,payment receipt',
      '--reply-deadline-hours',
      '48',
      '--gmail-destination',
      'gmail-vendors',
    );
    expect(payload.tripId).toBe('trip-goa');
    expect(payload.recipient).toBe('reservations@example-hotel.com');
    expect(payload.missingInfo).toEqual(['confirmation number', 'check-in time', 'payment receipt']);
    expect(payload.replyDeadlineHours).toBe(48);
    expect(payload.gmailDestination).toBe('gmail-vendors');
  });

  test('renders a plain-text Trip Goa vendor draft', () => {
    const draft = json<{ subject: string; plainText: string }>(
      'vendor',
      'draft',
      '--trip-name',
      'Trip Goa',
      '--recipient-label',
      'Example Hotel reservations',
      '--missing',
      'confirmation number,check-in time,payment receipt',
    );
    expect(draft.subject).toBe('Booking confirmation details for Trip Goa');
    expect(draft.plainText).toContain('Hello Example Hotel reservations,');
    expect(draft.plainText).toContain('- Confirmation number');
    expect(draft.plainText).toContain('Trip Goa coordinator');
  });

  test('builds a traveler info sequence and first draft', () => {
    const payload = json<{ workflowType?: string; stopOnReply: boolean; steps: Array<{ id: string; delayHours: number }> }>(
      'traveler',
      'sequence-payload',
      '--trip-id',
      'trip-goa',
      '--recipient',
      'naisha@example.com',
      '--traveler',
      'Naisha',
      '--fields',
      'passport name,dietary preference,rooming constraints',
    );
    expect(payload.stopOnReply).toBe(true);
    expect(payload.steps.map((step) => step.id)).toEqual(['initial_request', 'gentle_followup', 'final_reminder']);
    expect(payload.steps[1].delayHours).toBe(72);

    const draft = json<{ subject: string; plainText: string }>(
      'traveler',
      'draft',
      '--trip-name',
      'Trip Goa',
      '--traveler',
      'Naisha',
      '--fields',
      'passport name,dietary preference,rooming constraints',
    );
    expect(draft.subject).toBe('A few details for Trip Goa planning');
    expect(draft.plainText).toContain('Hi Naisha,');
    expect(draft.plainText).toContain('1. passport name');
    expect(draft.plainText).toContain('Reply on this thread');
  });
  test('derives vendor chase fields from a stay row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-db-')); const path = join(dir, 'trip.db'); const db = new Database(path); db.exec('CREATE TABLE stays (id INTEGER PRIMARY KEY, ref TEXT, check_in TEXT, booking_url TEXT); INSERT INTO stays VALUES (1,NULL,NULL,NULL)'); db.close();
    const payload = json<any>('vendor', 'payload', '--trip-id', 't', '--recipient', 'hotel@example.com', '--db', path, '--from', 'stays:1');
    expect(payload.missingInfo).toEqual(['confirmation number', 'check-in time', 'booking link/receipt']); rmSync(dir, { recursive: true, force: true });
  });
});
