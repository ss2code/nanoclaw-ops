import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initTestWorld, runAs } from './harness';

const fixture = (name: string) => path.join(import.meta.dir, 'fixtures', name);
const worlds: string[] = [];
afterEach(() => { for (const world of worlds.splice(0)) fs.rmSync(world, { recursive: true, force: true }); });

function seededWorld(): string {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-isolation-')); worlds.push(world); initTestWorld(world);
  const proposed = runAs(world, 'tutor-control', ['ingestion', 'propose', '--document', fixture('structured-hybrid-base-doc.md'), '--graph', 'Test_Mathematics_Fractions_KG', '--scope-type', 'chapter', '--scope-label', 'Fractions', '--json']);
  const proposal = JSON.parse(proposed.stdout);
  const committed = runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json']);
  expect(committed.exitCode).toBe(0);
  return world;
}

describe('routing-scoped student state', () => {
  test('prevents a peer memory canary from crossing routes', () => {
    const world = seededWorld();
    const remembered = runAs(world, 'student-a', ['memory', 'remember', '--title', 'Private canary', '--content', 'ORCHID-A-ONLY', '--json']);
    expect(remembered.exitCode).toBe(0);
    const peer = runAs(world, 'student-b', ['memory', 'recall', 'ORCHID-A-ONLY', '--json']);
    expect(peer.exitCode).toBe(0);
    expect(peer.stdout).not.toContain('ORCHID');
    expect(JSON.parse(peer.stdout).hit_count).toBe(0);
  });

  test('rejects caller-selected student targets and tutor operations', () => {
    const world = seededWorld();
    const targeted = runAs(world, 'student-b', ['context', 'current', '--student', 'stu_fixture_a']);
    expect(targeted.exitCode).toBe(64);
    const exportAttempt = runAs(world, 'student-a', ['admin', 'export-profile-memory', '--student', 'Asha']);
    expect(exportAttempt.exitCode).toBe(77);
  });

  test('records idempotent evidence and computes a prerequisite frontier', () => {
    const world = seededWorld();
    const missingEvidence = runAs(world, 'student-a', ['learning', 'record-attempt', '--concept', 'C01', '--difficulty', 'low', '--outcome', 'correct', '--idempotency', 'phantom-attempt', '--json']);
    expect(missingEvidence.exitCode).toBe(64);
    const first = runAs(world, 'student-a', ['learning', 'record-attempt', '--concept', 'C01', '--difficulty', 'low', '--outcome', 'correct', '--idempotency', 'attempt-a-001', '--evidence', '42 is greater because four tens exceed two tens', '--json']);
    expect(first.exitCode).toBe(0);
    const again = runAs(world, 'student-a', ['learning', 'record-attempt', '--concept', 'C01', '--difficulty', 'low', '--outcome', 'correct', '--idempotency', 'attempt-a-001', '--evidence', '42 is greater because four tens exceed two tens', '--json']);
    expect(JSON.parse(again.stdout).idempotent).toBe(true);
    const mastery = runAs(world, 'student-a', ['learning', 'mastery', '--concept', 'C01', '--json']);
    expect(JSON.parse(mastery.stdout).attempt_count).toBe(1);
    const frontier = runAs(world, 'student-a', ['context', 'frontier', '--json']);
    expect(JSON.parse(frontier.stdout).eligible.length).toBeGreaterThan(0);
  });

  test('queues one signed command and only the target applies it', () => {
    const world = seededWorld();
    const queued = runAs(world, 'tutor-control', ['admin', 'intervention-command', '--student', 'Asha', '--concept', 'C01', '--difficulty', 'medium', '--schedule', 'tomorrow 18:00', '--idempotency', 'cmd-a-001', '--json']);
    expect(queued.exitCode).toBe(0);
    const a = runAs(world, 'student-a', ['inbox', 'apply', '--json']);
    const b = runAs(world, 'student-b', ['inbox', 'apply', '--json']);
    expect(JSON.parse(a.stdout).applied_count).toBe(1);
    expect(JSON.parse(b.stdout).applied_count).toBe(0);
  });
});
