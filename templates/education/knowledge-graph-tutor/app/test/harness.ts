import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { initialize, type TutorInitialization } from '../../setup/initialize';
import { ensureDir, parseArgs, requiredFlag, TutorError } from '../util';

const ACTORS = {
  'tutor-control': { channel: 'cli', platform: 'tutor-control' },
  'student-a': { channel: 'cli', platform: 'student-a' },
  'student-b': { channel: 'cli', platform: 'student-b' },
} as const;

export function routingDb(root: string, actor: keyof typeof ACTORS): string {
  return path.join(root, 'routes', actor, 'inbound.db');
}

function seedRouting(file: string, channel: string, platform: string): void {
  ensureDir(path.dirname(file));
  const db = new Database(file, { create: true });
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY, channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.query(`INSERT OR REPLACE INTO session_routing (id,channel_type,platform_id,thread_id)
    VALUES (1,$channel,$platform,NULL)`).run({ $channel: channel, $platform: platform });
  db.close();
}

export function initTestWorld(root: string): void {
  ensureDir(root);
  fs.writeFileSync(path.join(root, '.tutor-test-world'), 'synthetic fixtures only\n');
  const config: TutorInitialization = {
    agentGroupId: 'ag-tutor-fixture', className: 'Test Class', subject: 'Mathematics',
    gradeLevel: 7, ageRange: { min: 13, max: 14 },
    tutor: { userId: 'cli:tutor', messagingGroupId: 'mg-tutor', channelType: 'cli', platformId: 'tutor-control' },
    students: [
      { id: 'stu_fixture_a', userId: 'cli:student-a', displayName: 'Asha', messagingGroupId: 'mg-student-a', channelType: 'cli', platformId: 'student-a' },
      { id: 'stu_fixture_b', userId: 'cli:student-b', displayName: 'Ben', messagingGroupId: 'mg-student-b', channelType: 'cli', platformId: 'student-b' },
    ],
  };
  initialize(root, config);
  for (const [actor, route] of Object.entries(ACTORS)) seedRouting(routingDb(root, actor as keyof typeof ACTORS), route.channel, route.platform);
}

export function runAs(root: string, actor: keyof typeof ACTORS, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const cli = path.resolve(import.meta.dir, '..', 'cli.ts');
  const result = Bun.spawnSync(['bun', cli, ...args], {
    env: { ...process.env, TUTOR_HARNESS: '1', TUTOR_APP_ROOT: root, TUTOR_INBOUND_DB: routingDb(root, actor) },
    stdout: 'pipe', stderr: 'pipe',
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    const verb = argv[0];
    const { flags } = parseArgs(argv.slice(1));
    const root = requiredFlag(flags, 'root');
    if (verb === 'init') {
      initTestWorld(root);
      console.log('TUTOR TEST WORLD READY\nstudents=2 control_channels=1 course_revision=0');
    } else if (verb === 'doctor') {
      const result = runAs(root, 'tutor-control', ['doctor', '--json']);
      process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.exitCode);
    } else if (verb === 'as') {
      const actor = argv[1] as keyof typeof ACTORS;
      if (!(actor in ACTORS)) throw new TutorError('unknown harness actor', 64);
      const separator = argv.indexOf('--');
      if (separator < 0) throw new TutorError('harness as requires -- before the tutor command', 64);
      let command = argv.slice(separator + 1);
      if (command[0] === 'bun') command = command.slice(2);
      const result = runAs(root, actor, command);
      process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.exitCode);
    } else throw new TutorError('usage: harness <init|doctor|as> --root <dir>', 64);
  } catch (error) {
    const code = error instanceof TutorError ? error.exitCode : 1;
    console.error(error instanceof Error ? error.message : String(error)); process.exit(code);
  }
}
