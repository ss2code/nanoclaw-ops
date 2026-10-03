import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-template-attach-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const TEMPLATES_DIR = path.join(TEST_ROOT, 'templates');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-template-attach-test/groups',
  DATA_DIR: '/tmp/nanoclaw-template-attach-test/data',
  TEMPLATES_DIR: '/tmp/nanoclaw-template-attach-test/templates',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../db/container-configs.js';
import {
  closeDb,
  createAgentGroup,
  createSession,
  getDb,
  getSessionsByAgentGroup,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { createDestination, getDestinations } from '../modules/agent-to-agent/db/agent-destinations.js';
import { insertTask } from '../modules/scheduling/db.js';
import { inboundDbPath, initSessionFolder, openInboundDb } from '../session-manager.js';
import type { AgentGroup } from '../types.js';
import { attachAgentGroupFromTemplate, detachAgentGroupTemplate } from './attach-agent.js';

function writeFile(rel: string, content: string): void {
  const file = path.join(TEMPLATES_DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeLegacyTemplate(): void {
  writeFile('legacy/context/instructions.md', 'Legacy instructions.\n');
  writeFile('legacy/context/playbook.md', '# Legacy playbook\n');
  writeFile('legacy/context/additional_context/faq.md', '# Legacy FAQ\n');
  writeFile('legacy/.mcp.json', JSON.stringify({ mcpServers: { legacy_tool: { command: 'legacy-tool' } } }));
  writeFile('legacy/skills/legacy-skill/SKILL.md', 'legacy skill\n');
}

function writePluginTemplate(version = '1.0.0', instructions = 'Plugin instructions.\n'): void {
  writeFile(
    'plugin/plugin.json',
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'fixture-plugin',
      version,
    }),
  );
  writeFile('plugin/ai.nanoco.nanoclaw/context/instructions.md', instructions);
  writeFile(
    'plugin/skills/plugin-skill/SKILL.md',
    '---\nname: plugin-skill\ndescription: Fixture skill\n---\n\nUse it.\n',
  );
  writeFile(
    'plugin/ai.nanoco.nanoclaw/tasks/daily.md',
    '---\nschedule: "0 8 * * *"\n---\n\nSend the daily fixture brief.\n',
  );
  writeFile(
    'plugin/mcp.json',
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { plugin_tool: { type: 'stdio', command: 'plugin-tool' } },
    }),
  );
}

function makeGroup(id: string, folder = id): AgentGroup {
  const group = { id, name: `Fixture ${id}`, folder, agent_provider: null, created_at: new Date().toISOString() };
  createAgentGroup(group);
  ensureContainerConfig(id);
  fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
  return group;
}

function seedExistingState(group: AgentGroup): {
  sessionId: string;
  inboundBefore: Buffer;
  containerBefore: Buffer;
  memoryBefore: Buffer;
} {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  const memoryBefore = Buffer.from('memory-fixture');
  fs.writeFileSync(path.join(groupDir, 'memory.db'), memoryBefore);
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'Private instructions.\n');
  fs.writeFileSync(path.join(groupDir, 'private-notes.md'), 'Never overwrite me.\n');
  const containerBefore = Buffer.from(
    JSON.stringify({ mcpServers: { private: { env: { TOKEN: 'keep-me' } } }, custom: true }),
  );
  fs.writeFileSync(path.join(groupDir, 'container.json'), containerBefore);

  const sessionId = 'session-existing';
  createSession({
    id: sessionId,
    agent_group_id: group.id,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  initSessionFolder(group.id, sessionId);
  const inbound = openInboundDb(group.id, sessionId);
  inbound
    .prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES ('fixture', 0, 'chat', datetime('now'), '{}')",
    )
    .run();
  insertTask(inbound, {
    id: 'private-schedule',
    processAfter: '2099-01-01T09:00:00.000Z',
    recurrence: '0 9 * * *',
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: 'Private scheduled work' }),
  });
  inbound.close();
  const inboundBefore = fs.readFileSync(inboundDbPath(group.id, sessionId));

  const privateMcp = {
    private: { command: 'private-tool', args: [], env: { TOKEN: 'keep-me' } },
  };
  updateContainerConfigJson(group.id, 'mcp_servers', privateMcp);
  updateContainerConfigScalars(group.id, { provider: 'opencode', model: 'private-model' });
  updateContainerConfigJson(group.id, 'additional_mounts', [
    { hostPath: '/private/fixture', containerPath: '/workspace/extra/fixture', readonly: true },
  ]);
  createDestination({
    agent_group_id: group.id,
    local_name: 'private-destination',
    target_type: 'agent',
    target_id: 'other-agent',
    created_at: new Date().toISOString(),
  });
  return { sessionId, inboundBefore, containerBefore, memoryBefore };
}

function fresh(): void {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
  writeLegacyTemplate();
  writePluginTemplate();
}

beforeEach(fresh);
afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('attachAgentGroupFromTemplate', () => {
  it('attaches to an existing group while preserving private state, config, session DBs, and destinations', () => {
    const group = makeGroup('legacy-group', 'existing-workspace');
    const preserved = seedExistingState(group);
    const beforeSessions = getSessionsByAgentGroup(group.id).map((session) => session.id);
    const result = attachAgentGroupFromTemplate(group.id, 'legacy');

    expect(result.status).toBe('applied');
    expect(result.action).toBe('attach');
    expect(result.provenance).toMatchObject({ ref: 'legacy', name: 'legacy', version: null, layout: 'legacy' });
    expect(getSessionsByAgentGroup(group.id).map((session) => session.id)).toEqual(beforeSessions);

    const groupDir = path.join(GROUPS_DIR, group.folder);
    expect(fs.readFileSync(path.join(groupDir, 'instructions.prepend.md'), 'utf8')).toBe('Legacy instructions.\n');
    expect(fs.readFileSync(path.join(groupDir, 'private-notes.md'), 'utf8')).toBe('Never overwrite me.\n');
    expect(fs.readFileSync(path.join(groupDir, 'memory.db'))).toEqual(preserved.memoryBefore);
    expect(fs.readFileSync(path.join(groupDir, 'container.json'))).toEqual(preserved.containerBefore);
    expect(fs.readFileSync(inboundDbPath(group.id, preserved.sessionId))).toEqual(preserved.inboundBefore);
    const scheduleDb = openInboundDb(group.id, preserved.sessionId);
    expect(
      scheduleDb.prepare("SELECT recurrence, content FROM messages_in WHERE id = 'private-schedule'").get(),
    ).toEqual({
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'Private scheduled work' }),
    });
    scheduleDb.close();
    expect(getDestinations(group.id)).toHaveLength(1);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.mcp_servers)).toEqual({
      private: { command: 'private-tool', args: [], env: { TOKEN: 'keep-me' } },
      legacy_tool: { command: 'legacy-tool' },
    });
    expect(config.provider).toBe('opencode');
    expect(config.model).toBe('private-model');
    expect(JSON.parse(config.additional_mounts)).toEqual([
      { hostPath: '/private/fixture', containerPath: '/workspace/extra/fixture', readonly: true },
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(groupDir, '.nanoclaw-template.json'), 'utf8'))).toMatchObject({
      schema: 2,
      provenance: { name: 'legacy', version: null, layout: 'legacy' },
    });
  });

  it('supports a dry-run diff without creating files, DB rows, or config changes', () => {
    const group = makeGroup('dry-run');
    const beforeConfig = getContainerConfig(group.id);
    const result = attachAgentGroupFromTemplate(group.id, 'legacy', { dryRun: true });

    expect(result.status).toBe('dry-run');
    expect(result.diff).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'add', kind: 'file' })]));
    expect(fs.existsSync(path.join(GROUPS_DIR, group.folder, '.nanoclaw-template.json'))).toBe(false);
    expect(getContainerConfig(group.id)).toEqual(beforeConfig);
    expect(getSessionsByAgentGroup(group.id)).toHaveLength(0);
  });

  it('records Agent Plugin provenance and restamps idempotently without duplicate skills, MCP entries, or tasks', () => {
    const group = makeGroup('plugin-group');
    const first = attachAgentGroupFromTemplate(group.id, 'plugin');
    expect(first.status).toBe('applied');
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const metadata = JSON.parse(fs.readFileSync(path.join(groupDir, '.nanoclaw-template.json'), 'utf8'));
    expect(metadata.provenance).toEqual({ name: 'fixture-plugin', version: '1.0.0', layout: 'agent-plugin' });
    expect(fs.existsSync(path.join(groupDir, 'plugins', 'fixture-plugin', 'plugin.json'))).toBe(true);
    expect(
      fs.existsSync(
        path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared', 'skills', 'plugin-skill', 'SKILL.md'),
      ),
    ).toBe(true);

    const taskSessionCount = getSessionsByAgentGroup(group.id).length;
    const second = attachAgentGroupFromTemplate(group.id, 'plugin');
    expect(second.status).toBe('applied');
    expect(second.idempotent).toBe(true);
    expect(second.changed).toBe(0);
    expect(getSessionsByAgentGroup(group.id)).toHaveLength(taskSessionCount);
    const taskCount = getSessionsByAgentGroup(group.id).reduce((total, session) => {
      const db = openInboundDb(group.id, session.id);
      const count = (
        db.prepare("SELECT COUNT(*) AS count FROM messages_in WHERE kind = 'task'").get() as { count: number }
      ).count;
      db.close();
      return total + count;
    }, 0);
    expect(taskCount).toBe(1);
    expect(JSON.parse(getContainerConfig(group.id)!.mcp_servers)).toEqual({
      plugin_tool: {
        command: 'plugin-tool',
        args: [],
        env: {},
        cwd: '${PLUGIN_ROOT}',
        plugin: 'fixture-plugin',
        pluginRoot: '/workspace/agent/plugins/fixture-plugin',
      },
    });
  });

  it('updates owned files on a version restamp but detects local edits instead of overwriting them', () => {
    const group = makeGroup('restamp-group');
    attachAgentGroupFromTemplate(group.id, 'plugin');
    writePluginTemplate('2.0.0', 'Updated plugin instructions.\n');
    const update = attachAgentGroupFromTemplate(group.id, 'plugin', { dryRun: true });
    expect(update.provenance.version).toBe('2.0.0');
    expect(update.diff).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'update', path: 'instructions.prepend.md' })]),
    );
    attachAgentGroupFromTemplate(group.id, 'plugin');
    expect(fs.readFileSync(path.join(GROUPS_DIR, group.folder, 'instructions.prepend.md'), 'utf8')).toBe(
      'Updated plugin instructions.\n',
    );

    fs.writeFileSync(path.join(GROUPS_DIR, group.folder, 'instructions.prepend.md'), 'Private edit.\n');
    const conflict = attachAgentGroupFromTemplate(group.id, 'plugin', { dryRun: true });
    expect(conflict.status).toBe('dry-run');
    expect(conflict.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'instructions.prepend.md' })]),
    );
    expect(() => attachAgentGroupFromTemplate(group.id, 'plugin')).toThrow(/local conflicts/i);
    expect(fs.readFileSync(path.join(GROUPS_DIR, group.folder, 'instructions.prepend.md'), 'utf8')).toBe(
      'Private edit.\n',
    );
  });

  it('blocks a new attachment from overwriting a local private file', () => {
    const group = makeGroup('private-conflict');
    fs.writeFileSync(path.join(GROUPS_DIR, group.folder, 'instructions.prepend.md'), 'Private persona.\n');
    const result = attachAgentGroupFromTemplate(group.id, 'legacy', { dryRun: true });
    expect(result.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'instructions.prepend.md' })]),
    );
    expect(() => attachAgentGroupFromTemplate(group.id, 'legacy')).toThrow(/local conflicts/i);
    expect(fs.readFileSync(path.join(GROUPS_DIR, group.folder, 'instructions.prepend.md'), 'utf8')).toBe(
      'Private persona.\n',
    );
    expect(fs.existsSync(path.join(GROUPS_DIR, group.folder, '.nanoclaw-template.json'))).toBe(false);
  });

  it('detaches with rollback semantics while retaining the group, private data, sessions, and task history', () => {
    const group = makeGroup('detach-group');
    const preserved = seedExistingState(group);
    attachAgentGroupFromTemplate(group.id, 'plugin');
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const taskSession = getSessionsByAgentGroup(group.id).find((session) =>
      session.thread_id?.startsWith('system:tasks:'),
    )!;
    const taskDb = openInboundDb(group.id, taskSession.id);
    const taskBefore = taskDb.prepare("SELECT id, content FROM messages_in WHERE kind = 'task'").get() as {
      id: string;
      content: string;
    };
    taskDb.close();

    const preview = detachAgentGroupTemplate(group.id, { dryRun: true });
    expect(preview.status).toBe('dry-run');
    expect(preview.diff).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'remove', kind: 'file' })]));
    const detached = detachAgentGroupTemplate(group.id);
    expect(detached.status).toBe('detached');
    expect(getDb().prepare('SELECT id, folder FROM agent_groups WHERE id = ?').get(group.id)).toEqual({
      id: group.id,
      folder: group.folder,
    });
    expect(fs.existsSync(groupDir)).toBe(true);
    expect(fs.existsSync(path.join(groupDir, '.nanoclaw-template.json'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'plugins', 'fixture-plugin'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'plugin-data', 'fixture-plugin'))).toBe(true);
    expect(fs.readFileSync(path.join(groupDir, 'memory.db'))).toEqual(preserved.memoryBefore);
    expect(fs.readFileSync(path.join(groupDir, 'container.json'))).toEqual(preserved.containerBefore);
    expect(fs.readFileSync(inboundDbPath(group.id, preserved.sessionId))).toEqual(preserved.inboundBefore);
    expect(getDestinations(group.id)).toHaveLength(1);

    const config = JSON.parse(getContainerConfig(group.id)!.mcp_servers);
    expect(config.plugin_tool).toBeUndefined();
    expect(config.private).toEqual({ command: 'private-tool', args: [], env: { TOKEN: 'keep-me' } });
    const afterTaskDb = openInboundDb(group.id, taskSession.id);
    const taskAfter = afterTaskDb
      .prepare('SELECT id, status, recurrence, content FROM messages_in WHERE id = ?')
      .get(taskBefore.id) as {
      id: string;
      status: string;
      recurrence: string | null;
      content: string;
    };
    afterTaskDb.close();
    expect(taskAfter).toMatchObject({
      id: taskBefore.id,
      status: 'paused',
      recurrence: null,
      content: taskBefore.content,
    });
  });

  it('detaches a Phase 1 schema-1 reference by inferring only byte-identical ownership', () => {
    const group = makeGroup('legacy-reference');
    attachAgentGroupFromTemplate(group.id, 'legacy');
    const refFile = path.join(GROUPS_DIR, group.folder, '.nanoclaw-template.json');
    fs.writeFileSync(refFile, JSON.stringify({ schema: 1, ref: 'legacy', mode: 'live' }));

    const result = detachAgentGroupTemplate(group.id);
    expect(result.status).toBe('detached');
    expect(fs.existsSync(path.join(GROUPS_DIR, group.folder, 'instructions.prepend.md'))).toBe(false);
    expect(fs.existsSync(refFile)).toBe(false);
    expect(getDb().prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(group.id)).toEqual({ 1: 1 });
  });
});
