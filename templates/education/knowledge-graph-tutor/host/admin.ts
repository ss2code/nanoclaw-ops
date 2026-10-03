/**
 * Config-driven lifecycle for a container-local knowledge-graph tutor.
 *
 * apply  -> agent group + template + class/student stores + shared-mode wires + optional approved ingestion
 * status -> central wiring plus tutor application health
 * ingest -> the real proposal/commit pipeline from the host bootstrap boundary
 * delete -> host-owned cascade; optional explicit disk purge for disposable instances
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, GROUPS_DIR } from '../../../../src/config.js';
import { materializeContainerJson } from '../../../../src/container-config.js';
import { initDb } from '../../../../src/db/connection.js';
import { createAgentGroup, getAgentGroup } from '../../../../src/db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../../../src/db/container-configs.js';
import {
  createMessagingGroup, createMessagingGroupAgent, getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform, getMessagingGroupsByAgentGroup, updateMessagingGroupAgent,
} from '../../../../src/db/messaging-groups.js';
import { initGroupFilesystem } from '../../../../src/group-init.js';
import { writeTemplateReference } from '../../../../src/template-runtime.js';
import { addMember } from '../../../../src/modules/permissions/db/agent-group-members.js';
import { getUser, upsertUser } from '../../../../src/modules/permissions/db/users.js';
import { resolveAudience } from '../app/audience.js';
import { readTutorApplicationStatusForGroup } from './status.js';

export interface TutorChannelConfig {
  channel: string;
  platformId: string;
  threadId?: string;
  name?: string;
}

export interface TutorStudentConfig {
  id?: string;
  user: string;
  displayName: string;
  channel: TutorChannelConfig;
}

export interface CourseworkConfig {
  document: string;
  source?: string;
  sourceMime?: string;
  extractionMethod?: string;
  extractorVersion?: string;
  ocrProvider?: string;
  generatedArtifacts?: string[];
  canonicalizerVersion?: string;
  canonicalizerPromptHash?: string;
  canonicalizerModel?: string;
  pageCount?: number;
  ocrConfidence?: number;
  graph: string;
  scopeType: string;
  scopeLabel: string;
  role?: string;
  approve?: boolean;
}

export interface KnowledgeGraphTutorConfig {
  id: string;
  name: string;
  folder: string;
  className: string;
  subject: string;
  gradeLevel: string;
  ageRange: { min: number; max: number };
  model?: string;
  tutor: { user: string; displayName?: string; channel: TutorChannelConfig };
  students: TutorStudentConfig[];
  coursework?: CourseworkConfig[];
}

const ID_RE = /^[a-z][a-z0-9-]{0,49}$/;
const FOLDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const USER_RE = /^[a-z0-9_-]+:.+$/i;
const STUDENT_ID_RE = /^stu_[a-zA-Z0-9_-]{1,64}$/;
const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function opaqueStudentId(groupId: string, userId: string): string {
  const digest = createHash('sha256').update(groupId).update('\u001f').update(userId).digest('hex');
  return `stu_${digest.slice(0, 20)}`;
}

export function wireEngagement(channel: string): { engageMode: 'pattern' | 'mention'; engagePattern: string | null } {
  return channel === 'cli'
    ? { engageMode: 'pattern', engagePattern: '.' }
    : { engageMode: 'mention', engagePattern: null };
}

export function parseTutorConfig(raw: unknown): { config: KnowledgeGraphTutorConfig | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, errors: ['config must be an object'], warnings };
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const folder = typeof o.folder === 'string' ? o.folder : '';
  const className = typeof o.className === 'string' ? o.className.trim() : '';
  const subject = typeof o.subject === 'string' ? o.subject.trim() : '';
  const model = typeof o.model === 'string' ? o.model.trim() : undefined;
  if (!ID_RE.test(id)) errors.push(`id must match ${ID_RE}`);
  if (!name) errors.push('name is required');
  if (!FOLDER_RE.test(folder)) errors.push(`folder must match ${FOLDER_RE}`);
  if (!className) errors.push('className is required');
  if (!subject) errors.push('subject is required');
  if (o.model !== undefined && !model) errors.push('model must be a non-empty model id when provided');
  let audience: ReturnType<typeof resolveAudience> | null = null;
  try {
    const age = (o.ageRange && typeof o.ageRange === 'object' ? o.ageRange : undefined) as Record<string, unknown> | undefined;
    audience = resolveAudience({
      className,
      gradeLevel: typeof o.gradeLevel === 'string' || typeof o.gradeLevel === 'number' ? o.gradeLevel : undefined,
      ageRange: age ? { min: Number(age.min), max: Number(age.max) } : undefined,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const parseChannel = (value: unknown, at: string): TutorChannelConfig | null => {
    const c = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const channel = typeof c.channel === 'string' ? c.channel : '';
    const platformId = typeof c.platformId === 'string' ? c.platformId : '';
    if (!channel) errors.push(`${at}.channel is required`);
    if (!platformId) errors.push(`${at}.platformId is required`);
    return channel && platformId ? { channel, platformId, threadId: typeof c.threadId === 'string' ? c.threadId : undefined, name: typeof c.name === 'string' ? c.name : undefined } : null;
  };

  const t = (o.tutor && typeof o.tutor === 'object' ? o.tutor : {}) as Record<string, unknown>;
  const tutorUser = typeof t.user === 'string' ? t.user : '';
  if (!USER_RE.test(tutorUser)) errors.push('tutor.user must be <channel>:<handle>');
  const tutorChannel = parseChannel(t.channel, 'tutor.channel');

  const students: TutorStudentConfig[] = [];
  if (!Array.isArray(o.students) || o.students.length === 0) errors.push('students must be a non-empty array');
  else o.students.forEach((entry, index) => {
    const s = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const user = typeof s.user === 'string' ? s.user : '';
    const displayName = typeof s.displayName === 'string' ? s.displayName.trim() : '';
    const studentId = typeof s.id === 'string' ? s.id : undefined;
    if (!USER_RE.test(user)) errors.push(`students[${index}].user must be <channel>:<handle>`);
    if (!displayName) errors.push(`students[${index}].displayName is required`);
    if (s.id !== undefined && (!studentId || !STUDENT_ID_RE.test(studentId))) {
      errors.push(`students[${index}].id must match ${STUDENT_ID_RE}`);
    }
    const channel = parseChannel(s.channel, `students[${index}].channel`);
    if (user && displayName && channel) students.push({ id: studentId, user, displayName, channel });
  });

  const allRoutes = [tutorChannel, ...students.map((s) => s.channel)].filter(Boolean) as TutorChannelConfig[];
  const routeKeys = new Set<string>();
  for (const route of allRoutes) {
    const key = `${route.channel}\u001f${route.platformId}\u001f${route.threadId ?? ''}`;
    if (routeKeys.has(key)) errors.push(`duplicate channel routing tuple ${route.channel}/${route.platformId}`);
    routeKeys.add(key);
  }
  const userKeys = new Set<string>();
  for (const student of students) {
    if (userKeys.has(student.user) || student.user === tutorUser) errors.push(`duplicate tutor/student user ${student.user}`);
    userKeys.add(student.user);
  }

  const coursework: CourseworkConfig[] = [];
  if (o.coursework !== undefined && !Array.isArray(o.coursework)) errors.push('coursework must be an array');
  else for (const [index, entry] of ((o.coursework as unknown[]) ?? []).entries()) {
    const c = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    for (const field of ['document', 'graph', 'scopeType', 'scopeLabel']) if (typeof c[field] !== 'string' || !String(c[field]).trim()) errors.push(`coursework[${index}].${field} is required`);
    if (typeof c.document === 'string' && !fs.existsSync(path.resolve(c.document))) warnings.push(`coursework[${index}] document is not currently readable: ${c.document}`);
    if (typeof c.source === 'string' && !fs.existsSync(path.resolve(c.source))) warnings.push(`coursework[${index}] source is not currently readable: ${c.source}`);
    if (c.generatedArtifacts !== undefined && (!Array.isArray(c.generatedArtifacts) || c.generatedArtifacts.some((value) => typeof value !== 'string'))) errors.push(`coursework[${index}].generatedArtifacts must be an array of paths`);
    if (Array.isArray(c.generatedArtifacts)) for (const artifact of c.generatedArtifacts) if (typeof artifact === 'string' && !fs.existsSync(path.resolve(artifact))) warnings.push(`coursework[${index}] generated artifact is not currently readable: ${artifact}`);
    if (['document', 'graph', 'scopeType', 'scopeLabel'].every((field) => typeof c[field] === 'string' && String(c[field]).trim())) coursework.push({
      document: String(c.document), graph: String(c.graph), scopeType: String(c.scopeType), scopeLabel: String(c.scopeLabel),
      source: typeof c.source === 'string' ? c.source : undefined, sourceMime: typeof c.sourceMime === 'string' ? c.sourceMime : undefined,
      extractionMethod: typeof c.extractionMethod === 'string' ? c.extractionMethod : undefined,
      extractorVersion: typeof c.extractorVersion === 'string' ? c.extractorVersion : undefined,
      ocrProvider: typeof c.ocrProvider === 'string' ? c.ocrProvider : undefined,
      generatedArtifacts: Array.isArray(c.generatedArtifacts) && c.generatedArtifacts.every((value) => typeof value === 'string') ? c.generatedArtifacts as string[] : undefined,
      canonicalizerVersion: typeof c.canonicalizerVersion === 'string' ? c.canonicalizerVersion : undefined,
      canonicalizerPromptHash: typeof c.canonicalizerPromptHash === 'string' ? c.canonicalizerPromptHash : undefined,
      canonicalizerModel: typeof c.canonicalizerModel === 'string' ? c.canonicalizerModel : undefined,
      pageCount: typeof c.pageCount === 'number' ? c.pageCount : undefined,
      ocrConfidence: typeof c.ocrConfidence === 'number' ? c.ocrConfidence : undefined,
      role: typeof c.role === 'string' ? c.role : undefined, approve: c.approve === true,
    });
  }
  if (students.length > 0 && students.length < 2) warnings.push('privacy UAT is stronger with at least two fake students');
  if (errors.length) return { config: null, errors, warnings };
  return {
    config: {
      id, name, folder, className, subject, model,
      gradeLevel: audience!.grade_level, ageRange: { min: audience!.age_min, max: audience!.age_max },
      tutor: { user: tutorUser, displayName: typeof t.displayName === 'string' ? t.displayName : undefined, channel: tutorChannel! },
      students, coursework,
    }, errors, warnings,
  };
}

export function resolveBunExecutable(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  const configured = env.NANOCLAW_BUN_PATH?.trim();
  if (configured) return configured;
  const installRoot = env.BUN_INSTALL?.trim() || path.join(env.HOME?.trim() || home, '.bun');
  const localBun = path.join(installRoot, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  return exists(localBun) ? localBun : 'bun';
}

export function formatBunFailure(result: Pick<SpawnSyncReturns<string>, 'status' | 'error' | 'stdout' | 'stderr'>): string {
  if (result.error) return result.error.message;
  return String(result.stderr || result.stdout || `bun exited ${result.status}`);
}

function runBun(args: string[], env?: NodeJS.ProcessEnv): string {
  const childEnv = { ...process.env, ...env };
  const bun = resolveBunExecutable(childEnv);
  const result = spawnSync(bun, args, { cwd: process.cwd(), encoding: 'utf8', env: childEnv });
  if (result.status !== 0) throw new Error(formatBunFailure(result));
  return result.stdout;
}

/** Keep nested host CLI calls on the same Node ABI as this admin process. */
function runHostCli(args: string[]): void {
  const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
  const client = path.resolve('src/cli/client.ts');
  execFileSync(process.execPath, [tsx, client, ...args], { cwd: process.cwd(), stdio: 'inherit' });
}

export function copyTemplate(config: KnowledgeGraphTutorConfig): string {
  const groupDir = path.resolve(GROUPS_DIR, config.folder);
  const root = path.join(groupDir, 'tutor-app');
  fs.mkdirSync(groupDir, { recursive: true });
  writeTemplateReference(groupDir, TEMPLATE_ROOT);
  fs.mkdirSync(root, { recursive: true });
  // The source tree is mounted read-only at runtime. Existing copied files
  // are deliberately left in place as a recovery artifact for older installs.
  fs.writeFileSync(path.join(root, 'instance.json'), JSON.stringify({
    schema: 2,
    agentGroupId: config.id,
    className: config.className,
    subject: config.subject,
    gradeLevel: config.gradeLevel,
    ageRange: config.ageRange,
    templateRef: 'education/knowledge-graph-tutor',
    runtimeSource: 'live',
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  return root;
}

function ensureUser(userId: string, displayName?: string): void {
  if (!getUser(userId)) upsertUser({ id: userId, kind: userId.split(':')[0], display_name: displayName ?? null, created_at: new Date().toISOString() });
}

function ensureWire(config: KnowledgeGraphTutorConfig, route: TutorChannelConfig, label: string): string {
  let mg = getMessagingGroupByPlatform(route.channel, route.platformId);
  if (!mg) {
    mg = {
      id: `mg-${config.id}-${label}`.slice(0, 100), channel_type: route.channel, platform_id: route.platformId,
      name: route.name ?? `${config.name} ${label}`, is_group: 1, unknown_sender_policy: 'strict', created_at: new Date().toISOString(),
    } as Parameters<typeof createMessagingGroup>[0];
    createMessagingGroup(mg);
  }
  const engagement = wireEngagement(route.channel);
  const existing = getMessagingGroupAgentByPair(mg.id, config.id);
  if (!existing) {
    createMessagingGroupAgent({
      id: randomUUID(), messaging_group_id: mg.id, agent_group_id: config.id,
      engage_mode: engagement.engageMode, engage_pattern: engagement.engagePattern,
      sender_scope: 'known', ignored_message_policy: 'drop', session_mode: 'shared', priority: 0, created_at: new Date().toISOString(),
    } as Parameters<typeof createMessagingGroupAgent>[0]);
  } else if (
    existing.engage_mode !== engagement.engageMode || existing.engage_pattern !== engagement.engagePattern ||
    existing.sender_scope !== 'known' || existing.ignored_message_policy !== 'drop' || existing.session_mode !== 'shared'
  ) {
    updateMessagingGroupAgent(existing.id, {
      engage_mode: engagement.engageMode,
      engage_pattern: engagement.engagePattern,
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: existing.priority,
    });
  }
  return mg.id;
}

function initializeApplication(config: KnowledgeGraphTutorConfig, root: string, tutorMg: string, studentMgs: string[]): void {
  const initConfig = {
    agentGroupId: config.id, className: config.className, subject: config.subject,
    gradeLevel: config.gradeLevel, ageRange: config.ageRange,
    tutor: { userId: config.tutor.user, messagingGroupId: tutorMg, channelType: config.tutor.channel.channel, platformId: config.tutor.channel.platformId, threadId: config.tutor.channel.threadId },
    students: config.students.map((student, index) => ({
      id: student.id ?? opaqueStudentId(config.id, student.user), userId: student.user, displayName: student.displayName,
      messagingGroupId: studentMgs[index], channelType: student.channel.channel, platformId: student.channel.platformId, threadId: student.channel.threadId, status: 'approved',
    })),
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-init-'));
  const tempConfig = path.join(tempDir, 'config.json');
  try {
    fs.writeFileSync(tempConfig, JSON.stringify(initConfig));
    process.stdout.write(runBun([path.join(TEMPLATE_ROOT, 'setup', 'initialize.ts'), '--root', root, '--config', tempConfig]));
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

function ingest(root: string, item: CourseworkConfig, approveOverride?: boolean): void {
  const args = [path.join(TEMPLATE_ROOT, 'setup', 'ingest.ts'), '--root', root, '--document', path.resolve(item.document), '--graph', item.graph, '--scope-type', item.scopeType, '--scope-label', item.scopeLabel, '--role', item.role ?? 'base'];
  if (item.source) args.push('--source', path.resolve(item.source));
  if (item.sourceMime) args.push('--source-mime', item.sourceMime);
  if (item.extractionMethod) args.push('--extraction-method', item.extractionMethod);
  if (item.extractorVersion) args.push('--extractor-version', item.extractorVersion);
  if (item.ocrProvider) args.push('--ocr-provider', item.ocrProvider);
  if (item.generatedArtifacts) args.push('--generated-artifacts', JSON.stringify(item.generatedArtifacts));
  if (item.canonicalizerVersion) args.push('--canonicalizer-version', item.canonicalizerVersion);
  if (item.canonicalizerPromptHash) args.push('--canonicalizer-prompt-hash', item.canonicalizerPromptHash);
  if (item.canonicalizerModel) args.push('--canonicalizer-model', item.canonicalizerModel);
  if (item.pageCount !== undefined) args.push('--page-count', String(item.pageCount));
  if (item.ocrConfidence !== undefined) args.push('--ocr-confidence', String(item.ocrConfidence));
  if (approveOverride ?? item.approve) args.push('--approve');
  process.stdout.write(runBun(args));
}

function optionalJsonStringArray(rest: string[], name: string): string[] | undefined {
  const index = rest.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (!value) throw new Error(`--${name} requires a JSON array of paths`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`--${name} must be a JSON array of paths`); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error(`--${name} must be a JSON array of paths`);
  return parsed;
}

function apply(config: KnowledgeGraphTutorConfig): void {
  const now = new Date().toISOString();
  let group = getAgentGroup(config.id);
  if (!group) {
    group = { id: config.id, name: config.name, folder: config.folder, agent_provider: null, created_at: now };
    createAgentGroup(group);
  } else if (group.folder !== config.folder) throw new Error(`agent group ${config.id} already uses groups/${group.folder}`);
  initGroupFilesystem(group);
  if (config.model && getContainerConfig(config.id)?.model !== config.model) updateContainerConfigScalars(config.id, { model: config.model });
  materializeContainerJson(config.id);
  const root = copyTemplate(config);
  ensureUser(config.tutor.user, config.tutor.displayName);
  addMember({ user_id: config.tutor.user, agent_group_id: config.id, added_by: null, added_at: now });
  const tutorMg = ensureWire(config, config.tutor.channel, 'tutor-control');
  const studentMgs = config.students.map((student, index) => {
    ensureUser(student.user, student.displayName);
    addMember({ user_id: student.user, agent_group_id: config.id, added_by: null, added_at: now });
    return ensureWire(config, student.channel, `student-${index + 1}`);
  });
  initializeApplication(config, root, tutorMg, studentMgs);
  for (const item of config.coursework ?? []) ingest(root, item);
  console.log(`KNOWLEDGE-GRAPH TUTOR READY id=${config.id} root=${root} wires=${studentMgs.length + 1}`);
}

function status(id: string, json = false): void {
  const group = getAgentGroup(id);
  if (!group) throw new Error(`agent group not found: ${id}`);
  const application = readTutorApplicationStatusForGroup(process.cwd(), group);
  console.log(json ? JSON.stringify({ application }, null, 2) : `Tutor ${group.name} (${id}) · students=${String(application.students)} · graphs=${String(application.graphs)}`);
}

function deleteTutor(id: string, purge: boolean): void {
  const group = getAgentGroup(id);
  if (!group) throw new Error(`agent group not found: ${id}`);
  try { runHostCli(['groups', 'restart', '--id', id]); }
  catch { console.warn('warning: no running container was stopped; continuing with the host-owned DB cascade'); }
  runHostCli(['groups', 'delete', '--id', id]);
  if (purge) {
    const groupDir = path.resolve(GROUPS_DIR, group.folder);
    const sessionsDir = path.resolve(DATA_DIR, 'v2-sessions', id);
    if (path.dirname(groupDir) !== path.resolve(GROUPS_DIR)) throw new Error('refusing unsafe group purge path');
    if (path.dirname(sessionsDir) !== path.resolve(DATA_DIR, 'v2-sessions')) throw new Error('refusing unsafe session purge path');
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    console.log(`PURGED disposable tutor files: ${groupDir} and ${sessionsDir}`);
  } else console.log(`Tutor ${id} removed from central state; groups/${group.folder} retained for recovery.`);
}

let initialized = false;
function ensureDb(): void {
  if (!initialized) { initDb(path.join(DATA_DIR, 'v2.db')); initialized = true; }
}

function main(): void {
  const [verb, target, ...rest] = process.argv.slice(2);
  if (!verb || ['help', '--help'].includes(verb)) {
    console.log('usage: knowledge-graph-tutor-admin <apply <config.json> | status <id> [--json] | ingest <id> --document ... --graph ... --scope-type ... --scope-label ... [--approve] | delete <id> --yes [--purge]>');
    return;
  }
  ensureDb();
  if (verb === 'apply') {
    if (!target) throw new Error('apply requires a config file');
    const parsed = parseTutorConfig(JSON.parse(fs.readFileSync(target, 'utf8')));
    for (const warning of parsed.warnings) console.warn(`warning: ${warning}`);
    if (!parsed.config) throw new Error(parsed.errors.join('\n'));
    apply(parsed.config);
  } else if (verb === 'status') {
    if (!target) throw new Error('status requires an agent group id'); status(target, rest.includes('--json'));
  } else if (verb === 'ingest') {
    if (!target) throw new Error('ingest requires an agent group id');
    const group = getAgentGroup(target); if (!group) throw new Error(`agent group not found: ${target}`);
    const flag = (name: string): string => { const index = rest.indexOf(`--${name}`); if (index < 0 || !rest[index + 1]) throw new Error(`--${name} is required`); return rest[index + 1]; };
    ingest(path.join(GROUPS_DIR, group.folder, 'tutor-app'), { document: flag('document'), graph: flag('graph'), scopeType: flag('scope-type'), scopeLabel: flag('scope-label'), role: rest.includes('--role') ? flag('role') : 'base', source: rest.includes('--source') ? flag('source') : undefined, sourceMime: rest.includes('--source-mime') ? flag('source-mime') : undefined, extractionMethod: rest.includes('--extraction-method') ? flag('extraction-method') : undefined, extractorVersion: rest.includes('--extractor-version') ? flag('extractor-version') : undefined, ocrProvider: rest.includes('--ocr-provider') ? flag('ocr-provider') : undefined, generatedArtifacts: optionalJsonStringArray(rest, 'generated-artifacts'), canonicalizerVersion: rest.includes('--canonicalizer-version') ? flag('canonicalizer-version') : undefined, canonicalizerPromptHash: rest.includes('--canonicalizer-prompt-hash') ? flag('canonicalizer-prompt-hash') : undefined, canonicalizerModel: rest.includes('--canonicalizer-model') ? flag('canonicalizer-model') : undefined, pageCount: rest.includes('--page-count') ? Number(flag('page-count')) : undefined, ocrConfidence: rest.includes('--ocr-confidence') ? Number(flag('ocr-confidence')) : undefined }, rest.includes('--approve'));
  } else if (verb === 'delete') {
    if (!target || !rest.includes('--yes')) throw new Error('delete requires <id> --yes'); deleteTutor(target, rest.includes('--purge'));
  } else throw new Error(`unknown verb ${verb}`);
}

if (process.argv[1]?.endsWith('knowledge-graph-tutor-admin.ts')) {
  try { main(); } catch (error) { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
