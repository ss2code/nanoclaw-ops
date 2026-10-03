/**
 * Safe template attachment for existing agent groups.
 *
 * A template attachment is deliberately a small, host-side overlay.  The
 * group id, group folder, memory store, session tree, container settings, and
 * destinations are not owned by the template.  Only artifacts listed in the
 * attachment manifest may be changed or removed later.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { type McpServerConfig } from '../container-config.js';
import { DATA_DIR, GROUPS_DIR, TEMPLATES_DIR } from '../config.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { inboundDbPath, openInboundDb, resolveTaskSession } from '../session-manager.js';
import { insertTask, updateTask } from '../modules/scheduling/db.js';
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import {
  emptyTemplateManagedState,
  readTemplateReference,
  writeTemplateReference,
  type TemplateManagedState,
  type TemplateProvenance,
  type TemplateReference,
  type TemplateReferenceV2,
} from '../template-runtime.js';
import type { AgentGroup } from '../types.js';
import { resolveLocalTemplate } from './local-dir.js';
import { markPluginServers, pluginDataCwdSubpaths } from './mcp.js';
import { copyPluginDir } from './plugin-dir.js';
import { parseTemplate, type Template } from './parse.js';
import { prepareTemplateTasks, taskNameSlug, type PreparedTemplateTask } from './tasks.js';

type ArtifactKind = 'file' | 'tree' | 'mcp' | 'task';
type DiffAction = 'add' | 'update' | 'remove' | 'preserve' | 'unchanged' | 'conflict';

export interface TemplateDiffEntry {
  action: DiffAction;
  kind: ArtifactKind;
  path: string;
  detail: string;
}

export interface TemplateConflict {
  kind: ArtifactKind;
  path: string;
  reason: string;
}

export interface TemplateAttachResult {
  groupId: string;
  folder: string;
  dryRun: boolean;
  action: 'attach' | 'restamp';
  status: 'dry-run' | 'applied' | 'conflict';
  changed: number;
  idempotent: boolean;
  provenance: TemplateProvenance & { ref: string };
  diff: TemplateDiffEntry[];
  conflicts: TemplateConflict[];
}

export interface TemplateDetachResult {
  groupId: string;
  folder: string;
  dryRun: boolean;
  status: 'dry-run' | 'detached' | 'conflict';
  changed: number;
  diff: TemplateDiffEntry[];
  conflicts: TemplateConflict[];
}

interface ExpectedFile {
  rel: string;
  content: string;
}

interface ExpectedTree {
  rel: string;
  source: string;
  plugin: boolean;
}

interface TaskCandidate {
  sessionId: string;
  row: TaskRow;
}

interface TaskRow {
  id: string;
  series_id: string | null;
  seq?: number;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
}

interface TaskPlan {
  source: string;
  task: PreparedTemplateTask;
  id: string;
  candidate?: TaskCandidate;
  action: 'add' | 'update' | 'adopt' | 'unchanged' | 'remove' | 'conflict';
  reason?: string;
  previousHash?: string;
}

interface PreparedAttachment {
  group: AgentGroup;
  groupDir: string;
  templateDir: string;
  template: Template;
  provenance: TemplateProvenance;
  ref: string;
  existingReference: TemplateReference | null;
  previousManaged: TemplateManagedState;
  expectedFiles: ExpectedFile[];
  expectedTrees: ExpectedTree[];
  expectedMcp: Record<string, McpServerConfig>;
  expectedTasks: PreparedTemplateTask[];
  filePlan: Map<string, DiffAction>;
  treePlan: Map<string, DiffAction>;
  mcpPlan: Map<string, DiffAction>;
  taskPlans: TaskPlan[];
  staleFiles: string[];
  staleTrees: string[];
  staleMcp: string[];
  staleTasks: Array<{ source: string; id: string; sessionId: string; hash: string }>;
  diff: TemplateDiffEntry[];
  conflicts: TemplateConflict[];
}

const emptyManaged = emptyTemplateManagedState;

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashObject(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function canonicalRef(templateDir: string): string {
  const relative = path.relative(TEMPLATES_DIR, path.resolve(templateDir));
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Template must live inside ${TEMPLATES_DIR}`);
  return relative.split(path.sep).join('/');
}

function provenanceFor(template: Template): TemplateProvenance {
  return { name: template.name, version: template.version ?? null, layout: template.layout };
}

function normalizeRelative(rel: string): string {
  const normalized = rel.split(path.sep).join('/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === ''))
    throw new Error(`Template artifact path is unsafe: ${rel}`);
  return normalized;
}

function groupPath(groupDir: string, rel: string): string {
  const safe = normalizeRelative(rel);
  const resolved = path.resolve(groupDir, ...safe.split('/'));
  const relative = path.relative(path.resolve(groupDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Template artifact escapes group: ${rel}`);
  return resolved;
}

function hasSymlinkParent(base: string, target: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true;
  let current = path.resolve(base);
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (stat?.isSymbolicLink()) return true;
    if (!stat) break;
  }
  return lstatOrNull(path.resolve(base))?.isSymbolicLink() ?? false;
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function fileHash(file: string): string | null {
  const stat = lstatOrNull(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  return sha256(fs.readFileSync(file));
}

function treeEntries(root: string): Array<{ rel: string; abs: string; data: Buffer }> {
  const entries: Array<{ rel: string; abs: string; data: Buffer }> = [];
  const visit = (relDir: string): void => {
    const absDir = relDir ? path.join(root, relDir) : root;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Template tree contains a symlink: ${abs}`);
      if (entry.isDirectory()) visit(rel);
      else if (entry.isFile()) entries.push({ rel, abs, data: fs.readFileSync(abs) });
      else throw new Error(`Template tree contains a non-regular entry: ${abs}`);
    }
  };
  visit('');
  return entries;
}

function treeHash(root: string): string | null {
  const stat = lstatOrNull(root);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return null;
  const hash = crypto.createHash('sha256');
  for (const entry of treeEntries(root)) hash.update(entry.rel).update('\0').update(entry.data).update('\0');
  return hash.digest('hex');
}

function copyTree(source: string, destination: string, plugin: boolean): void {
  if (plugin) {
    copyPluginDir(source, destination);
    return;
  }
  treeEntries(source);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of treeEntries(source)) {
    const target = path.join(destination, ...entry.rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    const mode = fs.statSync(entry.abs).mode & 0o777;
    fs.chmodSync(target, mode);
  }
}

function expectedFiles(template: Template): ExpectedFile[] {
  const files: ExpectedFile[] = [];
  if (template.instructions !== undefined)
    files.push({ rel: PERSONA_PREPEND_FILE, content: template.instructions + '\n' });
  for (const extra of template.contextExtras)
    files.push({ rel: normalizeRelative(extra.name), content: extra.content });
  return files;
}

function expectedTrees(template: Template, groupId: string): ExpectedTree[] {
  const trees: ExpectedTree[] = [];
  if (template.layout === 'agent-plugin') {
    trees.push({ rel: `plugins/${normalizeRelative(template.name)}`, source: template.dir, plugin: true });
  }
  for (const skill of template.skills) {
    trees.push({
      rel: `../__session-skills__/${groupId}/${normalizeRelative(skill.name)}`,
      source: skill.srcDir,
      plugin: template.layout === 'agent-plugin',
    });
  }
  return trees;
}

function actualTreePath(groupDir: string, tree: ExpectedTree): string {
  if (tree.rel.startsWith('../__session-skills__/')) {
    const rest = tree.rel.slice('../__session-skills__/'.length);
    const slash = rest.indexOf('/');
    const groupId = rest.slice(0, slash);
    const skill = rest.slice(slash + 1);
    return path.join(DATA_DIR, 'v2-sessions', groupId, '.claude-shared', 'skills', skill);
  }
  return groupPath(groupDir, tree.rel);
}

function displayTreePath(tree: ExpectedTree): string {
  return tree.rel.startsWith('../__session-skills__/')
    ? `.claude-shared/skills/${tree.rel.split('/').slice(-1)[0]}`
    : tree.rel;
}

function expectedMcp(template: Template): Record<string, McpServerConfig> {
  return template.layout === 'agent-plugin'
    ? markPluginServers(template.mcpServers, template.name)
    : template.mcpServers;
}

function taskId(template: Template, task: PreparedTemplateTask): string {
  const prefix = taskNameSlug(template.name) || 'template';
  const name = taskNameSlug(task.name);
  return `template-${prefix}-${name}`.slice(0, 64);
}

function taskFingerprint(row: Pick<TaskRow, 'recurrence' | 'content'>): string {
  let content: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) content = parsed as Record<string, unknown>;
  } catch {
    /* malformed local task content is treated as a conflict by the hash */
  }
  return hashObject({ recurrence: row.recurrence, prompt: content.prompt ?? null, script: content.script ?? null });
}

function desiredTaskFingerprint(task: PreparedTemplateTask): string {
  return hashObject({ recurrence: task.schedule, prompt: task.prompt, script: task.script ?? null });
}

function listTaskRows(groupId: string): TaskCandidate[] {
  const rows: TaskCandidate[] = [];
  for (const session of getSessionsByAgentGroup(groupId)) {
    const dbPath = inboundDbPath(groupId, session.id);
    if (!fs.existsSync(dbPath)) continue;
    const db = new Database(dbPath, { readonly: true });
    try {
      const taskRows = db
        .prepare(
          "SELECT id, series_id, seq, status, process_after, recurrence, content FROM messages_in WHERE kind = 'task'",
        )
        .all() as TaskRow[];
      for (const row of taskRows) rows.push({ sessionId: session.id, row });
    } finally {
      db.close();
    }
  }
  return rows;
}

function currentCandidate(
  rows: TaskCandidate[],
  id: string,
  task: PreparedTemplateTask,
  legacy = false,
): TaskCandidate | undefined {
  const byId = rows.filter(({ row }) => row.id === id || row.series_id === id);
  if (byId.length > 0) {
    const live = byId.filter(({ row }) => row.status === 'pending' || row.status === 'paused');
    return [...(live.length > 0 ? live : byId)].sort((a, b) => (a.row.seq ?? 0) - (b.row.seq ?? 0)).at(-1);
  }
  if (!legacy) return undefined;
  const exact = rows.filter(
    ({ row }) =>
      row.id.startsWith(`template-${taskNameSlug(task.name)}`) &&
      row.recurrence === task.schedule &&
      taskFingerprint(row) === desiredTaskFingerprint(task),
  );
  return exact.length === 1 ? exact[0] : undefined;
}

function latestTaskCandidate(rows: TaskCandidate[], id: string): TaskCandidate | undefined {
  const matches = rows.filter(({ row }) => row.id === id || row.series_id === id);
  const live = matches.filter(({ row }) => row.status === 'pending' || row.status === 'paused');
  return [...(live.length > 0 ? live : matches)].sort((a, b) => (a.row.seq ?? 0) - (b.row.seq ?? 0)).at(-1);
}

function priorManaged(reference: TemplateReference | null): TemplateManagedState {
  if (reference?.schema === 2) return reference.managed;
  return emptyManaged();
}

function addConflict(plan: PreparedAttachment, kind: ArtifactKind, artifactPath: string, reason: string): void {
  plan.conflicts.push({ kind, path: artifactPath, reason });
  plan.diff.push({ action: 'conflict', kind, path: artifactPath, detail: reason });
}

function addDiff(
  plan: PreparedAttachment,
  action: DiffAction,
  kind: ArtifactKind,
  artifactPath: string,
  detail: string,
): void {
  plan.diff.push({ action, kind, path: artifactPath, detail });
}

function planFile(plan: PreparedAttachment, expected: ExpectedFile): void {
  const target = groupPath(plan.groupDir, expected.rel);
  if (hasSymlinkParent(plan.groupDir, target)) {
    addConflict(plan, 'file', expected.rel, 'a parent directory is a symlink; attachment will not follow it');
    return;
  }
  const current = fileHash(target);
  const previous = plan.previousManaged.files[expected.rel]?.sha256;
  if (!current) {
    if (lstatOrNull(target))
      addConflict(plan, 'file', expected.rel, 'target exists but is not an unmodified regular template file');
    else {
      plan.filePlan.set(expected.rel, 'add');
      addDiff(plan, 'add', 'file', expected.rel, 'template-owned file will be created');
    }
    return;
  }
  const wanted = sha256(expected.content);
  if (previous && current !== previous && current !== wanted) {
    addConflict(plan, 'file', expected.rel, 'template-owned file was modified locally');
    return;
  }
  if (previous) {
    plan.filePlan.set(expected.rel, current === wanted ? 'unchanged' : 'update');
    addDiff(plan, current === wanted ? 'unchanged' : 'update', 'file', expected.rel, 'owned template file');
  } else if (current === wanted) {
    // Existing groups are private by default. Identical bytes are preserved,
    // not adopted, so detachment can never remove a pre-existing private file.
    plan.filePlan.set(expected.rel, 'preserve');
    addDiff(plan, 'preserve', 'file', expected.rel, 'existing private file is byte-compatible and remains private');
  } else {
    addConflict(plan, 'file', expected.rel, 'existing local/private file would be overwritten');
  }
}

function planTree(plan: PreparedAttachment, expected: ExpectedTree): void {
  const target = actualTreePath(plan.groupDir, expected);
  if (!expected.rel.startsWith('../__session-skills__') && hasSymlinkParent(plan.groupDir, target)) {
    addConflict(
      plan,
      'tree',
      displayTreePath(expected),
      'a parent directory is a symlink; attachment will not follow it',
    );
    return;
  }
  const current = treeHash(target);
  const previous = plan.previousManaged.trees[expected.rel]?.sha256;
  const sourceHash = treeHash(expected.source);
  if (!sourceHash) throw new Error(`Template tree source is missing or unsafe: ${expected.source}`);
  if (!current) {
    if (lstatOrNull(target))
      addConflict(plan, 'tree', displayTreePath(expected), 'target exists but is not a regular template directory');
    else {
      plan.treePlan.set(expected.rel, 'add');
      addDiff(plan, 'add', 'tree', displayTreePath(expected), 'template-owned directory will be copied');
    }
    return;
  }
  if (previous && current !== previous && current !== sourceHash) {
    addConflict(plan, 'tree', displayTreePath(expected), 'template-owned directory was modified locally');
    return;
  }
  if (previous) {
    plan.treePlan.set(expected.rel, current === sourceHash ? 'unchanged' : 'update');
    addDiff(
      plan,
      current === sourceHash ? 'unchanged' : 'update',
      'tree',
      displayTreePath(expected),
      'owned template directory',
    );
  } else if (current === sourceHash) {
    plan.treePlan.set(expected.rel, 'preserve');
    addDiff(
      plan,
      'preserve',
      'tree',
      displayTreePath(expected),
      'existing private directory is byte-compatible and remains private',
    );
  } else {
    addConflict(plan, 'tree', displayTreePath(expected), 'existing local/private directory would be overwritten');
  }
}

function planMcp(plan: PreparedAttachment): void {
  const row = getContainerConfig(plan.group.id);
  const current = row ? (JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>) : {};
  for (const [name, expected] of Object.entries(plan.expectedMcp)) {
    const currentValue = current[name];
    const currentHash = currentValue === undefined ? null : hashObject(currentValue);
    const previous = plan.previousManaged.mcpServers[name]?.sha256;
    const wanted = hashObject(expected);
    if (currentValue === undefined) {
      plan.mcpPlan.set(name, 'add');
      addDiff(plan, 'add', 'mcp', name, 'template MCP server will be added; existing servers remain untouched');
    } else if (previous && currentHash !== previous && currentHash !== wanted) {
      addConflict(plan, 'mcp', name, 'existing template-owned MCP entry contains local changes');
    } else if (previous) {
      plan.mcpPlan.set(name, currentHash === wanted ? 'unchanged' : 'update');
      addDiff(plan, currentHash === wanted ? 'unchanged' : 'update', 'mcp', name, 'owned template MCP entry');
    } else if (currentHash === wanted) {
      plan.mcpPlan.set(name, 'preserve');
      addDiff(plan, 'preserve', 'mcp', name, 'existing MCP entry is byte-compatible and remains private');
    } else {
      addConflict(
        plan,
        'mcp',
        name,
        'an existing MCP entry with this name differs; credentials/configuration will not be overwritten',
      );
    }
  }
  for (const [name, owned] of Object.entries(plan.previousManaged.mcpServers)) {
    if (plan.expectedMcp[name] !== undefined) continue;
    if (current[name] === undefined) continue;
    if (hashObject(current[name]) !== owned.sha256)
      addConflict(plan, 'mcp', name, 'removed template MCP entry was modified locally');
    else {
      plan.staleMcp.push(name);
      addDiff(plan, 'remove', 'mcp', name, 'MCP entry was owned by the previous template version');
    }
  }
}

function planTasks(plan: PreparedAttachment): void {
  const rows = listTaskRows(plan.group.id);
  const legacy = plan.existingReference?.schema === 1;
  const previous = plan.previousManaged.tasks;
  const seen = new Set<string>();
  for (const task of plan.expectedTasks) {
    const source = task.source;
    const id = previous[source]?.id ?? taskId(plan.template, task);
    const candidate = currentCandidate(rows, id, task, legacy);
    const previousEntry = previous[source];
    if (!candidate) {
      plan.taskPlans.push({ source, task, id, action: 'add' });
      addDiff(plan, 'add', 'task', source, 'template task series will be added (paused)');
      continue;
    }
    if (seen.has(candidate.row.id)) {
      addConflict(plan, 'task', source, 'multiple template tasks resolve to the same existing task series');
      continue;
    }
    seen.add(candidate.row.id);
    const currentHash = taskFingerprint(candidate.row);
    const wanted = desiredTaskFingerprint(task);
    if (previousEntry && currentHash !== previousEntry.sha256 && currentHash !== wanted) {
      plan.taskPlans.push({
        source,
        task,
        id,
        candidate,
        action: 'conflict',
        reason: 'template task was modified locally',
      });
      addConflict(plan, 'task', source, 'template-owned task prompt or schedule was modified locally');
    } else if (currentHash === wanted) {
      plan.taskPlans.push({
        source,
        task,
        id,
        candidate,
        action: previousEntry ? 'unchanged' : 'adopt',
        previousHash: currentHash,
      });
      addDiff(
        plan,
        previousEntry ? 'unchanged' : 'preserve',
        'task',
        source,
        previousEntry ? 'owned template task' : 'matching existing task remains private',
      );
    } else if (!previousEntry) {
      plan.taskPlans.push({ source, task, id, candidate, action: 'conflict', reason: 'existing task id is private' });
      addConflict(
        plan,
        'task',
        source,
        'an existing task uses the template task id but has different content or schedule',
      );
    } else {
      plan.taskPlans.push({ source, task, id, candidate, action: 'update', previousHash: currentHash });
      addDiff(plan, 'update', 'task', source, 'owned template task will be updated without changing its status');
    }
  }
  for (const [source, owned] of Object.entries(previous)) {
    if (plan.expectedTasks.some((task) => task.source === source)) continue;
    const candidate = latestTaskCandidate(rows, owned.id);
    if (!candidate) continue;
    if (taskFingerprint(candidate.row) !== owned.sha256)
      addConflict(plan, 'task', source, 'removed template task was modified locally');
    else {
      plan.staleTasks.push({ source, id: owned.id, sessionId: owned.sessionId, hash: owned.sha256 });
      addDiff(plan, 'remove', 'task', source, 'task will be paused and its recurrence cleared; history is retained');
    }
  }
}

function inferLegacyManaged(plan: PreparedAttachment): void {
  // Phase 1 references had only {ref, mode}; adopt an artifact only when its
  // bytes exactly match the old stamp. A mismatch stays private/conflicting.
  for (const expected of plan.expectedFiles) {
    const target = groupPath(plan.groupDir, expected.rel);
    if (fileHash(target) === sha256(expected.content))
      plan.previousManaged.files[expected.rel] = { sha256: sha256(expected.content) };
  }
  for (const expected of plan.expectedTrees) {
    const target = actualTreePath(plan.groupDir, expected);
    const sourceHash = treeHash(expected.source);
    if (sourceHash && treeHash(target) === sourceHash)
      plan.previousManaged.trees[expected.rel] = { sha256: sourceHash };
  }
  const row = getContainerConfig(plan.group.id);
  if (row) {
    const current = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
    for (const [name, value] of Object.entries(plan.expectedMcp)) {
      if (current[name] && hashObject(current[name]) === hashObject(value))
        plan.previousManaged.mcpServers[name] = { sha256: hashObject(value) };
    }
  }
  const rows = listTaskRows(plan.group.id);
  for (const task of plan.expectedTasks) {
    const candidate = currentCandidate(rows, taskId(plan.template, task), task, true);
    if (candidate && taskFingerprint(candidate.row) === desiredTaskFingerprint(task)) {
      plan.previousManaged.tasks[task.source] = {
        id: candidate.row.series_id ?? candidate.row.id,
        sessionId: candidate.sessionId,
        sha256: desiredTaskFingerprint(task),
        source: task.source,
      };
    }
  }
}

function addStaleArtifacts(plan: PreparedAttachment): void {
  for (const [rel, owned] of Object.entries(plan.previousManaged.files)) {
    if (plan.expectedFiles.some((file) => file.rel === rel)) continue;
    const current = fileHash(groupPath(plan.groupDir, rel));
    if (!current) continue;
    if (current !== owned.sha256) addConflict(plan, 'file', rel, 'removed template file was modified locally');
    else {
      plan.staleFiles.push(rel);
      addDiff(plan, 'remove', 'file', rel, 'file was owned by the previous template version');
    }
  }
  for (const [rel, owned] of Object.entries(plan.previousManaged.trees)) {
    if (plan.expectedTrees.some((tree) => tree.rel === rel)) continue;
    const expected = { rel, source: '', plugin: false } as ExpectedTree;
    const current = treeHash(actualTreePath(plan.groupDir, expected));
    if (!current) continue;
    if (current !== owned.sha256)
      addConflict(plan, 'tree', displayTreePath(expected), 'removed template directory was modified locally');
    else {
      plan.staleTrees.push(rel);
      addDiff(
        plan,
        'remove',
        'tree',
        displayTreePath(expected),
        'directory was owned by the previous template version',
      );
    }
  }
}

function validateRuntimeMountCollisions(plan: PreparedAttachment): void {
  for (const mount of plan.template.runtimeMounts) {
    const relative = mount.target.slice('/workspace/agent/'.length);
    const target = groupPath(plan.groupDir, relative);
    const source = path.join(plan.template.dir, mount.source);
    const sourceStat = lstatOrNull(source);
    if (!sourceStat) throw new Error(`Template runtime mount source is missing: ${source}`);
    const targetStat = lstatOrNull(target);
    if (!targetStat) continue;
    if (sourceStat.isFile() && (!targetStat.isFile() || targetStat.isSymbolicLink()))
      addConflict(
        plan,
        'file',
        relative,
        'runtime mount expects a regular file but the local workspace has another type',
      );
    if (sourceStat.isDirectory() && (!targetStat.isDirectory() || targetStat.isSymbolicLink()))
      addConflict(
        plan,
        'tree',
        relative,
        'runtime mount expects a regular directory but the local workspace has another type',
      );
  }
}

function prepareAttachment(group: AgentGroup, ref: string): PreparedAttachment {
  const templateDir = resolveLocalTemplate(ref);
  const template = parseTemplate(templateDir);
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const groupStat = lstatOrNull(groupDir);
  if (groupStat?.isSymbolicLink() || (groupStat && !groupStat.isDirectory()))
    throw new Error(`Group workspace is not a regular directory: ${groupDir}`);
  const existingReference = readTemplateReference(groupDir);
  const canonical = canonicalRef(templateDir);
  if (existingReference && existingReference.ref !== canonical) {
    throw new Error(
      `Group is already attached to template "${existingReference.ref}"; detach it before switching templates`,
    );
  }
  const plan: PreparedAttachment = {
    group,
    groupDir,
    templateDir,
    template,
    provenance: provenanceFor(template),
    ref: canonical,
    existingReference,
    previousManaged: priorManaged(existingReference),
    expectedFiles: expectedFiles(template),
    expectedTrees: expectedTrees(template, group.id),
    expectedMcp: expectedMcp(template),
    expectedTasks: prepareTemplateTasks(template.tasks),
    filePlan: new Map(),
    treePlan: new Map(),
    mcpPlan: new Map(),
    taskPlans: [],
    staleFiles: [],
    staleTrees: [],
    staleMcp: [],
    staleTasks: [],
    diff: [],
    conflicts: [],
  };
  if (existingReference?.schema === 1) inferLegacyManaged(plan);
  for (const file of plan.expectedFiles) planFile(plan, file);
  for (const tree of plan.expectedTrees) planTree(plan, tree);
  planMcp(plan);
  planTasks(plan);
  addStaleArtifacts(plan);
  validateRuntimeMountCollisions(plan);
  return plan;
}

function buildManagedState(plan: PreparedAttachment): TemplateManagedState {
  const managed = emptyManaged();
  for (const file of plan.expectedFiles) {
    const action = plan.filePlan.get(file.rel);
    if (action === 'add' || action === 'update' || action === 'unchanged' || plan.previousManaged.files[file.rel])
      managed.files[file.rel] = { sha256: sha256(file.content) };
  }
  for (const tree of plan.expectedTrees) {
    const action = plan.treePlan.get(tree.rel);
    const sourceHash = treeHash(tree.source)!;
    if (action === 'add' || action === 'update' || action === 'unchanged' || plan.previousManaged.trees[tree.rel])
      managed.trees[tree.rel] = { sha256: sourceHash };
  }
  for (const [name, value] of Object.entries(plan.expectedMcp)) {
    const action = plan.mcpPlan.get(name);
    if (action === 'add' || action === 'update' || action === 'unchanged' || plan.previousManaged.mcpServers[name])
      managed.mcpServers[name] = { sha256: hashObject(value) };
  }
  for (const taskPlan of plan.taskPlans) {
    if (!['add', 'update', 'adopt', 'unchanged'].includes(taskPlan.action)) continue;
    const candidate = taskPlan.candidate;
    managed.tasks[taskPlan.source] = {
      id: candidate?.row.series_id ?? candidate?.row.id ?? taskPlan.id,
      sessionId: candidate?.sessionId ?? '',
      sha256: desiredTaskFingerprint(taskPlan.task),
      source: taskPlan.source,
    };
  }
  return managed;
}

function applyFilePlan(plan: PreparedAttachment, managed: TemplateManagedState): void {
  for (const file of plan.expectedFiles) {
    const action = plan.filePlan.get(file.rel);
    if (action !== 'add' && action !== 'update') continue;
    const target = groupPath(plan.groupDir, file.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  for (const rel of plan.staleFiles) fs.rmSync(groupPath(plan.groupDir, rel), { force: true });
  for (const tree of plan.expectedTrees) {
    const action = plan.treePlan.get(tree.rel);
    if (action !== 'add' && action !== 'update') continue;
    copyTree(tree.source, actualTreePath(plan.groupDir, tree), tree.plugin);
  }
  for (const rel of plan.staleTrees) {
    const expected = { rel, source: '', plugin: false } as ExpectedTree;
    fs.rmSync(actualTreePath(plan.groupDir, expected), { recursive: true, force: true });
  }
  if (plan.template.layout === 'agent-plugin') {
    const dataRoot = path.join(plan.groupDir, 'plugin-data', plan.template.name);
    fs.mkdirSync(dataRoot, { recursive: true });
    for (const sub of pluginDataCwdSubpaths(plan.template.mcpServers))
      fs.mkdirSync(path.join(dataRoot, sub), { recursive: true });
  }
  void managed;
}

function applyMcpPlan(plan: PreparedAttachment): void {
  const row = getContainerConfig(plan.group.id);
  const current = row ? (JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>) : {};
  let changed = false;
  for (const [name, value] of Object.entries(plan.expectedMcp)) {
    const action = plan.mcpPlan.get(name);
    if (action === 'add' || action === 'update') {
      current[name] = value;
      changed = true;
    }
  }
  for (const name of plan.staleMcp) {
    delete current[name];
    changed = true;
  }
  if (changed) updateContainerConfigJson(plan.group.id, 'mcp_servers', current);
}

function applyTaskPlan(plan: PreparedAttachment, managed: TemplateManagedState): void {
  for (const taskPlan of plan.taskPlans) {
    if (taskPlan.action === 'add') {
      const { session } = resolveTaskSession(plan.group.id, taskPlan.id);
      const db = openInboundDb(plan.group.id, session.id);
      try {
        insertTask(db, {
          id: taskPlan.id,
          processAfter: taskPlan.task.processAfter,
          recurrence: taskPlan.task.schedule,
          platformId: null,
          channelType: null,
          threadId: null,
          content: JSON.stringify({
            prompt: taskPlan.task.prompt,
            script: taskPlan.task.script ?? null,
            originSessionId: null,
          }),
        });
        db.prepare("UPDATE messages_in SET status = 'paused' WHERE id = ?").run(taskPlan.id);
      } finally {
        db.close();
      }
      managed.tasks[taskPlan.source]!.sessionId = session.id;
    } else if (taskPlan.action === 'update' && taskPlan.candidate) {
      const db = openInboundDb(plan.group.id, taskPlan.candidate.sessionId);
      try {
        updateTask(db, taskPlan.candidate.row.series_id ?? taskPlan.candidate.row.id, {
          prompt: taskPlan.task.prompt,
          script: taskPlan.task.script ?? null,
          recurrence: taskPlan.task.schedule,
          processAfter: taskPlan.task.processAfter,
        });
      } finally {
        db.close();
      }
    }
  }
  for (const stale of plan.staleTasks) {
    const dbPath = inboundDbPath(plan.group.id, stale.sessionId);
    if (!fs.existsSync(dbPath)) continue;
    const db = openInboundDb(plan.group.id, stale.sessionId);
    try {
      db.prepare(
        "UPDATE messages_in SET status = 'paused', recurrence = NULL WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
      ).run(stale.id, stale.id);
    } finally {
      db.close();
    }
  }
}

/** Attach a local template to an existing group, or safely restamp it. */
export function attachAgentGroupFromTemplate(
  groupId: string,
  ref: string,
  options: { dryRun?: boolean } = {},
): TemplateAttachResult {
  const group = getAgentGroup(groupId);
  if (!group) throw new Error(`agent group not found: ${groupId}`);
  const plan = prepareAttachment(group, ref);
  const result: TemplateAttachResult = {
    groupId,
    folder: group.folder,
    dryRun: Boolean(options.dryRun),
    action: plan.existingReference ? 'restamp' : 'attach',
    status: options.dryRun ? 'dry-run' : plan.conflicts.length ? 'conflict' : 'applied',
    changed: plan.diff.filter((entry) => ['add', 'update', 'remove'].includes(entry.action)).length,
    idempotent:
      plan.conflicts.length === 0 && plan.diff.every((entry) => ['unchanged', 'preserve'].includes(entry.action)),
    provenance: { ...plan.provenance, ref: plan.ref },
    diff: plan.diff,
    conflicts: plan.conflicts,
  };
  if (options.dryRun || plan.conflicts.length) {
    if (plan.conflicts.length && !options.dryRun) throw new Error(formatConflicts(plan.conflicts));
    return result;
  }

  ensureContainerConfig(group.id);
  fs.mkdirSync(plan.groupDir, { recursive: true });
  const managed = buildManagedState(plan);
  applyFilePlan(plan, managed);
  applyMcpPlan(plan);
  applyTaskPlan(plan, managed);
  writeTemplateReference(plan.groupDir, plan.templateDir, plan.provenance, managed);
  return result;
}

function formatConflicts(conflicts: TemplateConflict[]): string {
  return `Template operation blocked by local conflicts:\n${conflicts.map((c) => `- ${c.kind} ${c.path}: ${c.reason}`).join('\n')}`;
}

interface DetachPlan {
  group: AgentGroup;
  groupDir: string;
  reference: TemplateReferenceV2;
  diff: TemplateDiffEntry[];
  conflicts: TemplateConflict[];
  files: string[];
  trees: string[];
  mcp: string[];
  tasks: Array<{ id: string; sessionId: string }>;
}

function prepareDetach(group: AgentGroup): DetachPlan {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const storedReference = readTemplateReference(groupDir);
  if (!storedReference) throw new Error(`Group is not attached to a template: ${group.id}`);
  let reference: TemplateReferenceV2;
  const legacyConflicts: TemplateConflict[] = [];
  if (storedReference.schema === 1) {
    // Safely support Phase 1 references: infer ownership only for artifacts
    // whose bytes still exactly match the referenced template. Anything else
    // remains private and is reported as a conflict by the same planner.
    const inferred = prepareAttachment(group, storedReference.ref);
    reference = {
      schema: 2,
      ref: storedReference.ref,
      mode: 'live',
      provenance: inferred.provenance,
      attachedAt: new Date().toISOString(),
      managed: inferred.previousManaged,
    };
    legacyConflicts.push(...inferred.conflicts);
  } else {
    reference = storedReference;
  }
  const plan: DetachPlan = {
    group,
    groupDir,
    reference,
    diff: [],
    conflicts: legacyConflicts,
    files: [],
    trees: [],
    mcp: [],
    tasks: [],
  };
  for (const [rel, owned] of Object.entries(reference.managed.files)) {
    const target = groupPath(groupDir, rel);
    const current = fileHash(target);
    if (!current) continue;
    if (current !== owned.sha256)
      plan.conflicts.push({ kind: 'file', path: rel, reason: 'template-owned file was modified locally' });
    else {
      plan.files.push(rel);
      plan.diff.push({
        action: 'remove',
        kind: 'file',
        path: rel,
        detail: 'remove template-owned file; local/private files are not touched',
      });
    }
  }
  for (const [rel, owned] of Object.entries(reference.managed.trees)) {
    const target = rel.startsWith('../__session-skills__/')
      ? actualTreePath(groupDir, { rel, source: '', plugin: false })
      : groupPath(groupDir, rel);
    const current = treeHash(target);
    if (!current) continue;
    if (current !== owned.sha256)
      plan.conflicts.push({
        kind: 'tree',
        path: displayTreePath({ rel, source: '', plugin: false }),
        reason: 'template-owned directory was modified locally',
      });
    else {
      plan.trees.push(rel);
      plan.diff.push({
        action: 'remove',
        kind: 'tree',
        path: displayTreePath({ rel, source: '', plugin: false }),
        detail: 'remove template-owned directory',
      });
    }
  }
  const row = getContainerConfig(group.id);
  const currentMcp = row ? (JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>) : {};
  for (const [name, owned] of Object.entries(reference.managed.mcpServers)) {
    if (currentMcp[name] === undefined) continue;
    if (hashObject(currentMcp[name]) !== owned.sha256)
      plan.conflicts.push({ kind: 'mcp', path: name, reason: 'template-owned MCP entry was modified locally' });
    else {
      plan.mcp.push(name);
      plan.diff.push({
        action: 'remove',
        kind: 'mcp',
        path: name,
        detail: 'remove template-owned MCP entry; credentials in other entries remain',
      });
    }
  }
  for (const owned of Object.values(reference.managed.tasks)) {
    const candidate = latestTaskCandidate(listTaskRows(group.id), owned.id);
    if (!candidate) continue;
    if (taskFingerprint(candidate.row) !== owned.sha256)
      plan.conflicts.push({ kind: 'task', path: owned.source, reason: 'template-owned task was modified locally' });
    else {
      plan.tasks.push({ id: owned.id, sessionId: candidate.sessionId });
      plan.diff.push({
        action: 'remove',
        kind: 'task',
        path: owned.source,
        detail: 'pause and clear recurrence; task history and session database are retained',
      });
    }
  }
  return plan;
}

/** Detach the current template overlay without deleting the group or its data. */
export function detachAgentGroupTemplate(groupId: string, options: { dryRun?: boolean } = {}): TemplateDetachResult {
  const group = getAgentGroup(groupId);
  if (!group) throw new Error(`agent group not found: ${groupId}`);
  const plan = prepareDetach(group);
  const result: TemplateDetachResult = {
    groupId,
    folder: group.folder,
    dryRun: Boolean(options.dryRun),
    status: options.dryRun ? 'dry-run' : plan.conflicts.length ? 'conflict' : 'detached',
    changed: plan.diff.length,
    diff: plan.diff,
    conflicts: plan.conflicts,
  };
  if (options.dryRun || plan.conflicts.length) {
    if (plan.conflicts.length && !options.dryRun) throw new Error(formatConflicts(plan.conflicts));
    return result;
  }
  for (const rel of plan.files) fs.rmSync(groupPath(plan.groupDir, rel), { force: true });
  for (const rel of plan.trees) {
    const target = rel.startsWith('../__session-skills__/')
      ? actualTreePath(plan.groupDir, { rel, source: '', plugin: false })
      : groupPath(plan.groupDir, rel);
    fs.rmSync(target, { recursive: true, force: true });
  }
  if (plan.mcp.length > 0) {
    const row = getContainerConfig(group.id);
    if (row) {
      const current = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
      for (const name of plan.mcp) delete current[name];
      updateContainerConfigJson(group.id, 'mcp_servers', current);
    }
  }
  for (const task of plan.tasks) {
    const dbPath = inboundDbPath(group.id, task.sessionId);
    if (!fs.existsSync(dbPath)) continue;
    const db = openInboundDb(group.id, task.sessionId);
    try {
      db.prepare(
        "UPDATE messages_in SET status = 'paused', recurrence = NULL WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
      ).run(task.id, task.id);
    } finally {
      db.close();
    }
  }
  fs.rmSync(path.join(plan.groupDir, '.nanoclaw-template.json'), { force: true });
  return result;
}
