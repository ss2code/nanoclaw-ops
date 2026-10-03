/**
 * Live user-level UAT for a disposable knowledge-graph tutor.
 *
 * Drives the real host router and provider through cli.sock, creates one
 * independent NanoClaw session per configured actor, then validates exact
 * application state instead of trusting conversational claims alone.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { parseTutorConfig, type KnowledgeGraphTutorConfig, type TutorChannelConfig } from '../templates/education/knowledge-graph-tutor/host/admin.js';

export interface Actor {
  key: string;
  user: string;
  displayName: string;
  channel: TutorChannelConfig;
}

export interface TurnResult {
  actor: Actor['key'];
  prompt: string;
  reply: string;
  sessionId: string;
  elapsedMs: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openCentral(): Database.Database {
  return new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });
}

function messagingGroupId(config: KnowledgeGraphTutorConfig, actor: Actor): string {
  const db = openCentral();
  try {
    const row = db.prepare(`SELECT id FROM messaging_groups
      WHERE channel_type=? AND platform_id=? AND COALESCE(instance,channel_type)=channel_type LIMIT 1`)
      .get(actor.channel.channel, actor.channel.platformId) as { id: string } | undefined;
    if (!row) throw new Error(`messaging group not found for ${actor.key}`);
    const wire = db.prepare(`SELECT session_mode FROM messaging_group_agents
      WHERE messaging_group_id=? AND agent_group_id=?`).get(row.id, config.id) as { session_mode: string } | undefined;
    if (wire?.session_mode !== 'shared') throw new Error(`${actor.key} is not wired with session_mode=shared`);
    return row.id;
  } finally { db.close(); }
}

function sessionFor(config: KnowledgeGraphTutorConfig, actor: Actor): { id: string; dir: string } | null {
  const mgId = messagingGroupId(config, actor);
  const db = openCentral();
  try {
    const row = db.prepare(`SELECT id FROM sessions WHERE agent_group_id=? AND messaging_group_id=? AND status='active'
      ORDER BY created_at DESC LIMIT 1`).get(config.id, mgId) as { id: string } | undefined;
    return row ? { id: row.id, dir: path.join(DATA_DIR, 'v2-sessions', config.id, row.id) } : null;
  } finally { db.close(); }
}

function outboundCursor(sessionDir: string): number {
  const file = path.join(sessionDir, 'outbound.db');
  if (!fs.existsSync(file)) return 0;
  const db = new Database(file, { fileMustExist: true });
  db.pragma('query_only = ON');
  try {
    return (db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM messages_out').get() as { n: number }).n;
  } finally { db.close(); }
}

function replyAfter(sessionDir: string, cursor: number): string | null {
  const file = path.join(sessionDir, 'outbound.db');
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { fileMustExist: true });
  db.pragma('query_only = ON');
  try {
    const row = db.prepare(`SELECT content FROM messages_out WHERE seq>? AND kind='chat' ORDER BY seq DESC LIMIT 1`)
      .get(cursor) as { content: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.content) as { text?: unknown };
      return typeof parsed.text === 'string' ? parsed.text : row.content;
    } catch { return row.content; }
  } finally { db.close(); }
}

function sendRouted(actor: Actor, text: string): Promise<void> {
  const payload = {
    text,
    to: { channelType: actor.channel.channel, platformId: actor.channel.platformId, threadId: actor.channel.threadId ?? null },
    sender: actor.displayName,
    senderName: actor.displayName,
    senderId: actor.user,
  };
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(DATA_DIR, 'cli.sock'));
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`cli.sock send timeout for ${actor.key}`)); }, 5000);
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n', (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else { setTimeout(() => socket.destroy(), 50); resolve(); }
    }));
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function sendAndWait(config: KnowledgeGraphTutorConfig, actor: Actor, prompt: string, timeoutMs = 240_000): Promise<TurnResult> {
  const before = sessionFor(config, actor);
  const cursor = before ? outboundCursor(before.dir) : 0;
  const started = Date.now();
  await sendRouted(actor, prompt);
  let session = before;
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    if (!session) session = sessionFor(config, actor);
    if (session) {
      const reply = replyAfter(session.dir, cursor);
      if (reply !== null) return { actor: actor.key, prompt, reply, sessionId: session.id, elapsedMs: Date.now() - started };
    }
    await sleep(1000);
  }
  throw new Error(`${actor.key} produced no chat reply within ${timeoutMs}ms`);
}

function studentIds(root: string): Array<{ id: string; display_name: string }> {
  const db = new Database(path.join(root, 'class.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare(`SELECT id,display_name FROM students WHERE status='approved' ORDER BY display_name`).all() as Array<{ id: string; display_name: string }>; }
  finally { db.close(); }
}

function scalar(dbFile: string, sql: string, ...params: unknown[]): number {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try { return Number((db.prepare(sql).get(...params) as { n: number }).n); }
  finally { db.close(); }
}

function buildChecks(config: KnowledgeGraphTutorConfig, root: string, turns: TurnResult[]): Check[] {
  const students = studentIds(root);
  const a = students.find((student) => student.display_name === config.students[0].displayName);
  const b = students.find((student) => student.display_name === config.students[1].displayName);
  if (!a || !b) throw new Error('configured UAT students are missing');
  const aDb = path.join(root, 'students', a.id, 'student.db');
  const bDb = path.join(root, 'students', b.id, 'student.db');
  const classDb = path.join(root, 'class.db');
  const courseDb = path.join(root, 'course', 'course.db');
  const sessionIds = new Set(turns.map((turn) => turn.sessionId));
  const studentAHelp = turns.find((turn) => turn.actor === 'student-a')?.reply ?? '';
  const studentBPrivacy = turns.find((turn) => turn.actor === 'student-b' && turn.prompt.includes('ORCHID'))?.reply ?? '';
  const tutorHelp = turns.find((turn) => turn.actor === 'tutor-control')?.reply ?? '';
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  add('two distinct approved students', students.length === 2 && a.id !== b.id, `${students.map((s) => `${s.display_name}:${s.id}`).join(', ')}`);
  add('three independent NanoClaw sessions', sessionIds.size === 3, [...sessionIds].join(', '));
  add('student help omits tutor mutation commands', !/export-profile-memory|intervention-command|ingestion commit/i.test(studentAHelp), studentAHelp.slice(0, 300));
  add('tutor help exposes control capabilities', /ingestion|admin|intervention|knowledge graph/i.test(tutorHelp), tutorHelp.slice(0, 300));
  add('Student A canary stored once', scalar(aDb, `SELECT COUNT(*) AS n FROM student_memories WHERE content='ORCHID-A-ONLY' AND status='active'`) === 1, 'student A memory count');
  add('Student B has no canary', scalar(bDb, `SELECT COUNT(*) AS n FROM student_memories WHERE content LIKE '%ORCHID%'`) === 0, 'student B memory count');
  add(
    'Student B response does not disclose Asha profile',
    !studentBPrivacy.includes(a.id) && !/Private canary|ORCHID-A-ONLY[^"'`\s]*\s+(?:was|is)\s+(?:found|stored)/i.test(studentBPrivacy),
    studentBPrivacy.slice(0, 300),
  );
  add('student admin denial happened before mutation', scalar(classDb, `SELECT COUNT(*) AS n FROM audit_events WHERE actor_role='student' AND action LIKE 'admin.%'`) === 0, 'student admin audit count');
  add('attempt idempotency is enforced', scalar(aDb, `SELECT COUNT(*) AS n FROM learning_events WHERE idempotency_key='live-attempt-a-001'`) === 1, 'attempt count');
  add('Student A current action persisted', scalar(aDb, `SELECT COUNT(*) AS n FROM current_state WHERE id=1 AND concept_code='C01'`) === 1, 'student A action count');
  add('Student B current action remains separate', scalar(bDb, `SELECT COUNT(*) AS n FROM current_state`) === 0, 'student B action count');
  add('targeted command applied only by Student A', scalar(aDb, `SELECT COUNT(*) AS n FROM applied_commands`) === 1 && scalar(bDb, `SELECT COUNT(*) AS n FROM applied_commands`) === 0, 'A=1 B=0');
  add('shared course revision remains singular', scalar(courseDb, `SELECT COUNT(*) AS n FROM knowledge_graphs WHERE version=1`) === 1, 'course graph count');
  add('all user turns received replies', turns.length === 8 && turns.every((turn) => turn.reply.trim().length > 0), `turns=${turns.length}`);
  return checks;
}

async function main(): Promise<void> {
  const [configPath, flag] = process.argv.slice(2);
  if (!configPath) throw new Error('usage: knowledge-graph-tutor-uat <config.json> [--json]');
  const parsed = parseTutorConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  if (!parsed.config) throw new Error(parsed.errors.join('\n'));
  if (parsed.config.students.length !== 2) throw new Error('live UAT requires exactly two fake students');
  const config = parsed.config;
  const group = openCentral().prepare('SELECT folder FROM agent_groups WHERE id=?').get(config.id) as { folder: string } | undefined;
  if (!group) throw new Error(`agent group not found: ${config.id}`);
  const root = path.join(GROUPS_DIR, group.folder, 'tutor-app');
  const actors: Actor[] = [
    { key: 'tutor-control', user: config.tutor.user, displayName: config.tutor.displayName ?? 'Test Tutor', channel: config.tutor.channel },
    { key: 'student-a', user: config.students[0].user, displayName: config.students[0].displayName, channel: config.students[0].channel },
    { key: 'student-b', user: config.students[1].user, displayName: config.students[1].displayName, channel: config.students[1].channel },
  ];
  const [tutor, studentA, studentB] = actors;
  const turns: TurnResult[] = [];
  turns.push(...await Promise.all([
    sendAndWait(config, studentA, 'UAT A1. Run `bun /workspace/agent/tutor-app/app/cli.ts context current --json` and then `.../cli.ts help --json`. Reply with the exact role-filtered results only.'),
    sendAndWait(config, studentB, 'UAT B1. Run `bun /workspace/agent/tutor-app/app/cli.ts context current --json` and then `.../cli.ts help --json`. Reply with the exact role-filtered results only.'),
  ]));
  turns.push(await sendAndWait(config, tutor, 'UAT T1. Run `bun /workspace/agent/tutor-app/app/cli.ts context current --json` and `.../cli.ts help --json`. Reply with the exact tutor-control results only.'));
  turns.push(await sendAndWait(config, studentA, 'UAT A2. Using only the tutor CLI: remember title "Private canary" with content "ORCHID-A-ONLY"; set current action for C01 type retrieval prompt "What does the denominator count?" expected evidence "number of equal parts" difficulty low; record the same correct low C01 attempt twice with idempotency key live-attempt-a-001. Return every exact JSON result.'));
  turns.push(await sendAndWait(config, studentB, 'UAT B2. Using only the tutor CLI, recall ORCHID-A-ONLY; then attempt `admin export-profile-memory --student Asha`; then run context current. Do not inspect files or guess. Report exact hit_count, the admin command exit/error, and your own scoped context.'));
  turns.push(await sendAndWait(config, tutor, 'UAT T2. Using only the tutor CLI, queue an intervention for student Asha, concept C01, difficulty medium, schedule "tomorrow 18:00", idempotency live-cmd-a-001. Then show graph Synthetic6_Mathematics_Fractions_KG. Return the exact command receipt and graph revision.'));
  turns.push(...await Promise.all([
    sendAndWait(config, studentA, 'UAT A3. Using only the tutor CLI, apply your inbox and search course concept C01 at medium difficulty for "equivalent parts". Return exact applied_count plus the first result provenance and graph_revision.'),
    sendAndWait(config, studentB, 'UAT B3. Using only the tutor CLI, apply your inbox and search course concept C01 at medium difficulty for "equivalent parts". Return exact applied_count plus the first result provenance and graph_revision.'),
  ]));

  const checks = buildChecks(config, root, turns);
  const report = { schema: 1, runAt: new Date().toISOString(), agentGroupId: config.id, checks, turns };
  const reportDir = path.join('logs', 'knowledge-graph-tutor-uat');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (flag === '--json') console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  else {
    for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    console.log(`REPORT ${reportPath}`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main().catch((error) => { console.error(`UAT ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
