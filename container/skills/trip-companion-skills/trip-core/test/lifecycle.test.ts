import { describe, expect, test } from 'bun:test';
import { openCoreDb } from '../scripts/db';
import { setTrip } from '../scripts/config';
import {
  STAGES,
  canTransition,
  cancel,
  getStage,
  legalTransitions,
  regress,
  transition,
} from '../scripts/lifecycle';

function freshTrip() {
  const db = openCoreDb(':memory:');
  setTrip(db, { name: 'T', baseCurrency: 'INR' }, null, '2026-01-01T00:00:00');
  return db;
}

function journalActions(db: ReturnType<typeof openCoreDb>): { action: string; before: any; after: any }[] {
  return (
    db.query("SELECT action, before_json, after_json FROM journal WHERE action LIKE 'lifecycle%' ORDER BY id").all() as {
      action: string;
      before_json: string | null;
      after_json: string | null;
    }[]
  ).map((r) => ({
    action: r.action,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
  }));
}

describe('lifecycle state machine (§11)', () => {
  test('a fresh trip starts in the planning stage', () => {
    const db = freshTrip();
    expect(getStage(db)).toBe('planning');
  });

  test('STAGES lists the seven forward stages in order', () => {
    expect(STAGES).toEqual([
      'planning', 'plan_ready', 'start_trip', 'on_trip', 'trip_complete', 'post_trip', 'archived',
    ]);
  });

  test('the full forward path is legal and lands each stage', () => {
    const db = freshTrip();
    let at = 0;
    for (const next of ['plan_ready', 'start_trip', 'on_trip', 'trip_complete', 'post_trip', 'archived']) {
      transition(db, next, 1, `2026-02-0${++at}T00:00:00`);
      expect(getStage(db)).toBe(next);
    }
  });

  test('illegal skip is rejected and leaves the stage untouched', () => {
    const db = freshTrip();
    expect(() => transition(db, 'on_trip', 1, '2026-02-01T00:00:00')).toThrow(/illegal/i);
    expect(getStage(db)).toBe('planning');
  });

  test('regress steps back exactly one stage', () => {
    const db = freshTrip();
    transition(db, 'plan_ready', 1, '2026-02-01T00:00:00');
    transition(db, 'start_trip', 1, '2026-02-02T00:00:00');
    regress(db, 1, '2026-02-03T00:00:00');
    expect(getStage(db)).toBe('plan_ready');
    regress(db, 1, '2026-02-04T00:00:00');
    expect(getStage(db)).toBe('planning');
  });

  test('regress from planning is rejected (nothing before it)', () => {
    const db = freshTrip();
    expect(() => regress(db, 1, '2026-02-01T00:00:00')).toThrow(/cannot regress/i);
  });

  test('cancel is allowed from every pre-trip stage', () => {
    for (const pre of ['planning', 'plan_ready', 'start_trip']) {
      const db = freshTrip();
      // walk to `pre`
      const path = STAGES.slice(1, STAGES.indexOf(pre) + 1);
      let at = 0;
      for (const s of path) transition(db, s, 1, `2026-02-0${++at}T00:00:00`);
      expect(getStage(db)).toBe(pre);
      cancel(db, 1, '2026-03-01T00:00:00');
      expect(getStage(db)).toBe('cancelled');
    }
  });

  test('cancel is rejected once travel has begun (on_trip is not pre-trip)', () => {
    const db = freshTrip();
    let at = 0;
    for (const s of ['plan_ready', 'start_trip', 'on_trip']) transition(db, s, 1, `2026-02-0${++at}T00:00:00`);
    expect(() => cancel(db, 1, '2026-03-01T00:00:00')).toThrow(/cannot cancel/i);
    expect(getStage(db)).toBe('on_trip');
  });

  test('cancelled goes only to archived', () => {
    const db = freshTrip();
    cancel(db, 1, '2026-03-01T00:00:00');
    expect(legalTransitions('cancelled')).toEqual(['archived']);
    expect(() => transition(db, 'planning', 1, '2026-03-02T00:00:00')).toThrow(/illegal/i);
    transition(db, 'archived', 1, '2026-03-03T00:00:00');
    expect(getStage(db)).toBe('archived');
  });

  test('archived is terminal', () => {
    const db = freshTrip();
    let at = 0;
    for (const s of ['plan_ready', 'start_trip', 'on_trip', 'trip_complete', 'post_trip', 'archived']) {
      transition(db, s, 1, `2026-02-0${++at}T00:00:00`);
    }
    expect(legalTransitions('archived')).toEqual([]);
    expect(() => transition(db, 'post_trip', 1, '2026-04-01T00:00:00')).toThrow(/terminal|illegal/i);
  });

  test('canTransition reports legality and the legal set without mutating', () => {
    const db = freshTrip();
    const c = canTransition(db, 'on_trip');
    expect(c.ok).toBe(false);
    expect(c.from).toBe('planning');
    expect(c.legal).toEqual(['plan_ready', 'cancelled']);
    expect(getStage(db)).toBe('planning');
  });

  test('every transition is journaled with before/after stage', () => {
    const db = freshTrip();
    transition(db, 'plan_ready', 7, '2026-02-01T00:00:00');
    regress(db, 7, '2026-02-02T00:00:00');
    const entries = journalActions(db);
    expect(entries.map((e) => e.action)).toEqual(['lifecycle.transition', 'lifecycle.transition']);
    expect(entries[0]).toMatchObject({ before: { stage: 'planning' }, after: { stage: 'plan_ready' } });
    expect(entries[1]).toMatchObject({ before: { stage: 'plan_ready' }, after: { stage: 'planning' } });
  });
});
