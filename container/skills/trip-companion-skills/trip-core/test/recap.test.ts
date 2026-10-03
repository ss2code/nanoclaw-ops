import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoreDb } from '../scripts/db';
import { addMember, setTrip } from '../scripts/config';
import { setParticipation } from '../scripts/participation';
import { addNote } from '../scripts/scratchpad';
import { closeDecision, openDecision, recordVote } from '../scripts/decisions';
import { transition } from '../scripts/lifecycle';
import { buildRecap } from '../scripts/recap';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-recap-'));
  dbPath = join(dir, 'trip.db');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seed() {
  const db = openCoreDb(dbPath);
  setTrip(db, { name: 'Goa 2026', baseCurrency: 'INR' }, null, '2026-01-01T00:00:00');
  const a = addMember(db, { displayName: 'Arjun', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00');
  const b = addMember(db, { displayName: 'Maya', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00');
  setParticipation(db, a, 'planning', 'in', null, a, '2026-01-02T00:00:00');
  setParticipation(db, b, 'planning', 'in', null, a, '2026-01-02T00:00:00');
  addNote(db, { authorMemberId: b, topic: 'food', note: 'Maya leans off-beat, quieter' }, '2026-01-02T03:00:00');
  const open = openDecision(db, { question: 'Where to?', mode: 'poll', options: ['Goa', 'Gokarna'], stage: 'planning', openedBy: a }, '2026-01-02T04:00:00');
  recordVote(db, open, a, 'Goa', '2026-01-02T04:05:00');
  const closed = openDecision(db, { question: 'Dates?', mode: 'propose', commitBy: '2026-01-03T21:00:00', openedBy: a }, '2026-01-02T05:00:00');
  closeDecision(db, closed, '14–17 Aug', '2026-01-02T06:00:00');
  return { db, a, b };
}

describe('recap — grounding / restart (§13, Gate 4)', () => {
  test('recap reflects exactly the seeded working state', () => {
    const { db } = seed();
    const recap = buildRecap(db);
    db.close();

    expect(recap.stage).toBe('planning');
    expect(recap.roster.map((r) => r.display_name)).toEqual(['Arjun', 'Maya']);
    expect(recap.scratchpad.map((n) => n.note)).toEqual(['Maya leans off-beat, quieter']);
    expect(recap.decisions.open.map((d) => d.question)).toEqual(['Where to?']);
    expect(recap.decisions.closed.map((d) => d.outcome)).toEqual(['14–17 Aug']);
    // No invented rows: counts match exactly what was seeded.
    expect(recap.decisions.open.length).toBe(1);
    expect(recap.scratchpad.length).toBe(1);
  });

  test('after a simulated restart (DB reopen), recap rebuilds the identical state', () => {
    const { db } = seed();
    const before = JSON.stringify(buildRecap(db));
    db.close();

    // Restart: a brand-new handle on the same file (migrateCore is idempotent).
    const reopened = openCoreDb(dbPath);
    const after = JSON.stringify(buildRecap(reopened));
    reopened.close();

    expect(after).toBe(before);
  });

  test('recap tracks the current stage after a transition', () => {
    const { db } = seed();
    transition(db, 'plan_ready', 1, '2026-02-01T00:00:00');
    const recap = buildRecap(db);
    db.close();
    expect(recap.stage).toBe('plan_ready');
  });

  test('recap tolerates absent planning tables (Phase-1 shape: candidates empty)', () => {
    const { db } = seed();
    const recap = buildRecap(db);
    db.close();
    expect(recap.candidates).toEqual([]);
  });
});
