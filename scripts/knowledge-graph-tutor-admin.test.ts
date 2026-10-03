import { describe, expect, test } from 'vitest';

import {
  formatBunFailure,
  opaqueStudentId,
  parseTutorConfig,
  resolveBunExecutable,
  wireEngagement,
} from '../templates/education/knowledge-graph-tutor/host/admin.js';

const valid = {
  id: 'ag-kg-test', name: 'KG Test Tutor', folder: 'kg-test-tutor', className: 'Test Class', subject: 'Mathematics',
  gradeLevel: 7, ageRange: { min: 13, max: 14 },
  tutor: { user: 'cli:tutor', channel: { channel: 'cli', platformId: 'kg-tutor-control' } },
  students: [
    { user: 'cli:student-a', displayName: 'Asha', channel: { channel: 'cli', platformId: 'kg-student-a' } },
    { user: 'cli:student-b', displayName: 'Ben', channel: { channel: 'cli', platformId: 'kg-student-b' } },
  ],
};

describe('knowledge-graph tutor lifecycle config', () => {
  test('derives deterministic user-specific opaque student ids', () => {
    const first = opaqueStudentId('ag-kg-test', 'cli:student-a');
    const repeat = opaqueStudentId('ag-kg-test', 'cli:student-a');
    const second = opaqueStudentId('ag-kg-test', 'cli:student-b');

    expect(first).toBe(repeat);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^stu_[a-f0-9]{20}$/);
  });

  test('uses only router-supported engagement modes', () => {
    expect(wireEngagement('cli')).toEqual({ engageMode: 'pattern', engagePattern: '.' });
    expect(wireEngagement('telegram')).toEqual({ engageMode: 'mention', engagePattern: null });
  });

  test('accepts one control route and separate shared-session student routes', () => {
    const parsed = parseTutorConfig(valid);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.students).toHaveLength(2);
  });

  test('rejects duplicate routing tuples before writes', () => {
    const bad = structuredClone(valid);
    bad.students[1].channel.platformId = bad.students[0].channel.platformId;
    const parsed = parseTutorConfig(bad);
    expect(parsed.config).toBeNull();
    expect(parsed.errors.join(' ')).toContain('duplicate channel routing tuple');
  });

  test('rejects a tutor identity reused as a student', () => {
    const bad = structuredClone(valid);
    bad.students[0].user = bad.tutor.user;
    const parsed = parseTutorConfig(bad);
    expect(parsed.config).toBeNull();
    expect(parsed.errors.join(' ')).toContain('duplicate tutor/student user');
  });

  test('rejects an unsafe custom student id before lifecycle writes', () => {
    const bad = structuredClone(valid);
    bad.students[0].id = '../../outside';
    const parsed = parseTutorConfig(bad);
    expect(parsed.config).toBeNull();
    expect(parsed.errors.join(' ')).toContain('students[0].id must match');
  });

  test('resolves user-local Bun when launchd PATH omits the Bun directory', () => {
    const home = '/Users/operator';
    const env = { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin' };
    const expected = `${home}/.bun/bin/bun`;

    expect(resolveBunExecutable(env, home, (candidate) => candidate === expected)).toBe(expected);
  });

  test('honors an explicit Bun executable override', () => {
    expect(resolveBunExecutable({ NANOCLAW_BUN_PATH: '/opt/bun/bin/bun' }, '/Users/operator', () => false))
      .toBe('/opt/bun/bin/bun');
  });

  test('reports spawn errors when Bun cannot be started', () => {
    expect(formatBunFailure({
      status: null,
      error: new Error('spawnSync bun ENOENT'),
      stdout: '',
      stderr: '',
    })).toBe('spawnSync bun ENOENT');
  });
});
