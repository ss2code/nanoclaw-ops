import { describe, expect, test } from 'bun:test';
import { ensureColumn, openCoreDb } from '../scripts/db';
import { addFamily, addMember, setTrip } from '../scripts/config';
import { participantsForStage, setParticipation } from '../scripts/participation';
import { addRelationship, listRelationships } from '../scripts/relationships';
import { addNote, openNotes, resolveNote } from '../scripts/scratchpad';
import {
  closeDecision,
  dueForAutoCommit,
  openDecision,
  recordObjection,
  recordVote,
  tally,
} from '../scripts/decisions';
import { indexAsset, listAssets } from '../scripts/assets';
import {
  addRecommendation,
  applyVoteProxies,
  bookingReadiness,
  buildCatchupCard,
  buildDecisionBoard,
  listActivitySignups,
  setActivitySignup,
  setVoteProxy,
} from '../scripts/planning-ux';

function seed() {
  const db = openCoreDb(':memory:');
  setTrip(db, { name: 'T', baseCurrency: 'INR' }, null, '2026-01-01T00:00:00');
  addFamily(db, 'Kapoor', null, '2026-01-01T00:00:00');
  const ids = [
    addMember(db, { displayName: 'Arjun', familyId: 1, joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00'),
    addMember(db, { displayName: 'Diya', familyId: 1, joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00'),
    addMember(db, { displayName: 'Maya', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00'),
    addMember(db, { displayName: 'Raj', joinedAt: '2026-01-01' }, null, '2026-01-01T00:00:00'),
  ];
  return { db, ids };
}

describe('stage participation (§12)', () => {
  test('setParticipation upserts per (member, stage); participantsForStage reads it back', () => {
    const { db, ids } = seed();
    setParticipation(db, ids[0], 'planning', 'in', null, 1, '2026-01-02T00:00:00');
    setParticipation(db, ids[1], 'planning', 'in', null, 1, '2026-01-02T00:00:00');
    setParticipation(db, ids[2], 'planning', 'out', 'cannot make these dates', 1, '2026-01-02T00:00:00');
    // a different stage is independent
    setParticipation(db, ids[0], 'on_trip', 'in', null, 1, '2026-01-02T00:00:00');

    const planning = participantsForStage(db, 'planning');
    expect(planning.map((p) => [p.display_name, p.status])).toEqual([
      ['Arjun', 'in'], ['Diya', 'in'], ['Maya', 'out'],
    ]);
    expect(participantsForStage(db, 'on_trip').map((p) => p.display_name)).toEqual(['Arjun']);
  });

  test('setParticipation re-run for the same (member, stage) updates in place', () => {
    const { db, ids } = seed();
    setParticipation(db, ids[0], 'planning', 'in', null, 1, '2026-01-02T00:00:00');
    setParticipation(db, ids[0], 'planning', 'out', 'changed mind', 1, '2026-01-03T00:00:00');
    const rows = participantsForStage(db, 'planning');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ display_name: 'Arjun', status: 'out', note: 'changed mind' });
  });
});

test('ensureColumn is additive and idempotent for a legacy table', () => {
  const db = openCoreDb(':memory:');
  db.exec('CREATE TABLE legacy (id INTEGER PRIMARY KEY)');
  ensureColumn(db, 'legacy', 'note', 'note TEXT');
  ensureColumn(db, 'legacy', 'note', 'note TEXT');
  expect((db.query('PRAGMA table_info(legacy)').all() as any[]).map((c) => c.name)).toContain('note');
});

describe('relationships (§7)', () => {
  test('addRelationship + listRelationships round-trip', () => {
    const { db, ids } = seed();
    addRelationship(db, ids[0], ids[1], 'spouse', 'Arjun & Diya', 1, '2026-01-02T00:00:00');
    const rels = listRelationships(db);
    expect(rels.length).toBe(1);
    expect(rels[0]).toMatchObject({
      member_id: ids[0], related_member_id: ids[1], kind: 'spouse', note: 'Arjun & Diya',
    });
  });
});

describe('scratchpad — ungated working notes (§13)', () => {
  test('addNote is open by default; resolveNote closes it; openNotes filters', () => {
    const { db, ids } = seed();
    const n1 = addNote(db, { authorMemberId: ids[0], topic: 'flights', note: 'Maya leans morning departure' }, '2026-01-02T00:00:00');
    addNote(db, { authorMemberId: ids[2], topic: 'food', note: 'veg only for Raj' }, '2026-01-02T01:00:00');
    expect(openNotes(db).length).toBe(2);
    resolveNote(db, n1, '2026-01-03T00:00:00');
    const open = openNotes(db);
    expect(open.length).toBe(1);
    expect(open[0].topic).toBe('food');
  });
});

describe('decisions — consensus record + deterministic tally (§14)', () => {
  test('poll: recordVote upserts per voter; tally counts and breaks ties by option order', () => {
    const { db, ids } = seed();
    const d = openDecision(db, {
      question: 'Where to?',
      mode: 'poll',
      options: ['Goa', 'Gokarna', 'Pondicherry'],
      stage: 'planning',
      openedBy: ids[0],
    }, '2026-01-02T00:00:00');
    recordVote(db, d, ids[3], 'Goa', '2026-01-02T01:00:00');
    recordVote(db, d, ids[2], 'Gokarna', '2026-01-02T01:05:00');
    let t = tally(db, d);
    expect(t.counts).toEqual({ Goa: 1, Gokarna: 1 });
    expect(t.votes).toBe(2);
    expect(t.leader).toBe('Goa'); // tie → first option listed

    // a voter changes their mind — upsert, not append
    recordVote(db, d, ids[2], 'Goa', '2026-01-02T02:00:00');
    t = tally(db, d);
    expect(t.counts).toEqual({ Goa: 2 });
    expect(t.votes).toBe(2);
    expect(t.leader).toBe('Goa');
  });

  test('closeDecision records the outcome and closes it', () => {
    const { db, ids } = seed();
    const d = openDecision(db, { question: 'Q', mode: 'poll', options: ['A', 'B'], openedBy: ids[0] }, '2026-01-02T00:00:00');
    closeDecision(db, d, 'A', '2026-01-02T03:00:00');
    const row = db.query('SELECT status, outcome, closed_at FROM decisions WHERE id = $id').get({ $id: d }) as any;
    expect(row.status).toBe('closed');
    expect(row.outcome).toBe('A');
    expect(row.closed_at).toBe('2026-01-02T03:00:00');
  });

  test('propose-with-deadline: due for auto-commit only past commit_by and with no objection', () => {
    const { db, ids } = seed();
    const settled = openDecision(db, {
      question: 'Lock Goa 14–17 Aug?', mode: 'propose', commitBy: '2026-01-02T21:00:00', stage: 'planning', openedBy: ids[0],
    }, '2026-01-02T18:00:00');
    const contested = openDecision(db, {
      question: 'Lock the cruise?', mode: 'propose', commitBy: '2026-01-02T21:00:00', openedBy: ids[0],
    }, '2026-01-02T18:00:00');
    const future = openDecision(db, {
      question: 'Lock dinner?', mode: 'propose', commitBy: '2026-01-05T21:00:00', openedBy: ids[0],
    }, '2026-01-02T18:00:00');
    recordObjection(db, contested, ids[2], '2026-01-02T20:00:00');

    // before the deadline: nothing is due
    expect(dueForAutoCommit(db, '2026-01-02T20:00:00').map((x) => x.id)).toEqual([]);
    // after the deadline: only the un-objected, past-deadline proposal
    const due = dueForAutoCommit(db, '2026-01-02T21:30:00');
    expect(due.map((x) => x.id)).toEqual([settled]);
    expect(due.map((x) => x.id)).not.toContain(contested);
    expect(due.map((x) => x.id)).not.toContain(future);
  });
});

describe('planning-stage UX projections', () => {
  test('decision board reports pending voters, ties, stale decisions, and next actions', () => {
    const { db, ids } = seed();
    const d = openDecision(db, {
      question: 'Where should we stay?',
      mode: 'poll',
      options: ['Rosetta', 'Devadhare'],
      stage: 'planning',
      openedBy: ids[0],
    }, '2026-01-01T00:00:00');
    recordVote(db, d, ids[0], 'Rosetta', '2026-01-01T01:00:00');
    recordVote(db, d, ids[2], 'Devadhare', '2026-01-01T01:10:00');
    setVoteProxy(db, { fromMemberId: ids[3], toMemberId: ids[2], decisionId: d }, ids[0], '2026-01-01T01:30:00');

    const board = buildDecisionBoard(db, '2026-01-06T00:00:00', { staleDays: 3 });
    expect(board.open[0].pending).toEqual(['Diya', 'Raj']);
    expect(board.open[0].tied).toEqual(['Rosetta', 'Devadhare']);
    expect(board.open[0].stale).toBe(true);
    expect(board.text).toContain('proxy: Raj follows Maya');
    expect(board.nextActions.join(' ')).toContain('break tie');
  });

  test('catchup card gives a compact late-joiner summary', () => {
    const { db, ids } = seed();
    const d = openDecision(db, { question: 'Which weekend?', mode: 'poll', options: ['A', 'B'] }, '2026-01-02T00:00:00');
    closeDecision(db, d, 'A', '2026-01-02T03:00:00');
    addNote(db, { authorMemberId: ids[0], topic: 'stay', note: 'Prefer clean estate stays' }, '2026-01-02T04:00:00');
    indexAsset(db, { kind: 'doc', label: 'Stay options', path: 'stay-options.html', addedBy: ids[0] }, '2026-01-02T05:00:00');

    const card = buildCatchupCard(db, '2026-01-03T00:00:00');
    expect(card.text).toContain('T catch-up');
    expect(card.text).toContain('Decisions: 1 locked, 0 open');
    expect(card.text).toContain('Prefer clean estate stays');
    expect(card.text).toContain('Stay options');
  });

  test('proxy apply mirrors source votes only when the follower has not voted', () => {
    const { db, ids } = seed();
    const d = openDecision(db, { question: 'Stay?', mode: 'poll', options: ['Villa', 'Resort'] }, '2026-01-02T00:00:00');
    recordVote(db, d, ids[2], 'Villa', '2026-01-02T01:00:00');
    setVoteProxy(db, { fromMemberId: ids[3], toMemberId: ids[2], decisionId: d }, ids[0], '2026-01-02T01:10:00');

    const applied = applyVoteProxies(db, d, '2026-01-02T01:20:00');
    expect(applied.applied).toEqual([{ proxy: 1, member: 'Raj', choice: 'Villa' }]);
    expect(tally(db, d).counts).toEqual({ Villa: 2 });

    const second = applyVoteProxies(db, d, '2026-01-02T01:30:00');
    expect(second.applied).toEqual([]);
    expect(second.skipped[0]).toMatchObject({ proxy: 1 });
  });

  test('booking readiness blocks on open decisions and weak recommendation sources', () => {
    const { db, ids } = seed();
    openDecision(db, { question: 'Pick stay?', mode: 'poll', options: ['A', 'B'] }, '2026-01-02T00:00:00');
    addRecommendation(db, { category: 'stay', title: 'Villa Aroor', confidence: 'unknown' }, ids[0], '2026-01-02T00:10:00');

    const readiness = bookingReadiness(db);
    expect(readiness.ok).toBe(false);
    expect(readiness.missing.join('\n')).toContain('open decision');
    expect(readiness.missing.join('\n')).toContain('source confidence');
  });

  test('activity signups upsert per activity/member', () => {
    const { db, ids } = seed();
    setActivitySignup(db, { activity: 'Morning trek', memberId: ids[0], status: 'interested' }, ids[0], '2026-01-02T00:00:00');
    setActivitySignup(db, { activity: 'Morning trek', memberId: ids[0], status: 'out', note: 'knee rest' }, ids[0], '2026-01-02T01:00:00');
    const rows = listActivitySignups(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ activity: 'Morning trek', display_name: 'Arjun', status: 'out', note: 'knee rest' });
  });
});

describe('assets index (§16)', () => {
  test('indexAsset + listAssets with kind filter', () => {
    const { db, ids } = seed();
    indexAsset(db, { kind: 'ticket', label: 'Cruise booking', path: 'assets/tickets/cruise.pdf', addedBy: ids[0], stage: 'planning', tags: ['cruise'] }, '2026-01-02T00:00:00');
    indexAsset(db, { kind: 'photo', label: 'Beach', path: 'assets/photos/beach.jpg', addedBy: ids[1], tags: [] }, '2026-01-02T01:00:00');
    expect(listAssets(db).length).toBe(2);
    const tickets = listAssets(db, { kind: 'ticket' });
    expect(tickets.length).toBe(1);
    expect(tickets[0]).toMatchObject({ label: 'Cruise booking', path: 'assets/tickets/cruise.pdf' });
  });
});
