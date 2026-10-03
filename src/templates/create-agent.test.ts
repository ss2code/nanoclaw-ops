import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-create-agent-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const TEMPLATES_DIR = path.join(TEST_ROOT, 'templates');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-create-agent-test/groups',
  DATA_DIR: '/tmp/nanoclaw-create-agent-test/data',
  TEMPLATES_DIR: '/tmp/nanoclaw-create-agent-test/templates',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, getSessionsByAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { getContainerConfig } from '../db/container-configs.js';
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import { createAgentFromTemplate } from './create-agent.js';
import { inboundDbPath } from '../session-manager.js';

function writeTemplate(): void {
  const t = path.join(TEMPLATES_DIR, 'sales', 'sdr');
  fs.mkdirSync(path.join(t, 'context', 'additional_context'), { recursive: true });
  fs.writeFileSync(path.join(t, 'context', 'instructions.md'), 'You are an SDR agent.\n');
  fs.writeFileSync(path.join(t, 'context', 'playbook.md'), '# Playbook\n');
  fs.writeFileSync(path.join(t, 'context', 'additional_context', 'faq.md'), '# FAQ\n');
  fs.writeFileSync(
    path.join(t, '.mcp.json'),
    JSON.stringify({ mcpServers: { hubspot: { command: 'npx', args: ['-y', '@hubspot/mcp-server'] } } }),
  );
  const skillDir = path.join(t, 'skills', 'widget');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: widget\n---\n');
}

function writePluginTemplate(): void {
  const t = path.join(TEMPLATES_DIR, 'lifestyle', 'family-assistant');
  fs.mkdirSync(path.join(t, 'ai.nanoco.nanoclaw', 'context'), { recursive: true });
  fs.mkdirSync(path.join(t, 'skills', 'family-assistant'), { recursive: true });
  fs.writeFileSync(
    path.join(t, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'family-assistant',
    }),
  );
  fs.writeFileSync(path.join(t, 'ai.nanoco.nanoclaw', 'context', 'instructions.md'), 'Family persona.\n');
  fs.writeFileSync(
    path.join(t, 'skills', 'family-assistant', 'SKILL.md'),
    '---\nname: family-assistant\ndescription: Household workflows\n---\n\nRoute requests.\n',
  );
  fs.mkdirSync(path.join(t, 'ai.nanoco.nanoclaw', 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(t, 'ai.nanoco.nanoclaw', 'tasks', 'morning.md'),
    '---\nschedule: "0 7 * * *"\n---\n\nSend the morning brief.\n',
  );
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
  writeTemplate();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('createAgentFromTemplate', () => {
  it('writes the persona prepend verbatim — no injected context refs, no .seed.md', () => {
    const g = createAgentFromTemplate('sales/sdr', { name: 'SDR Test' });

    const groupDir = path.join(GROUPS_DIR, g.folder);
    const prepend = fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8');
    expect(prepend).toBe('You are an SDR agent.\n');
    expect(fs.existsSync(path.join(groupDir, '.seed.md'))).toBe(false);
  });

  it('copies template skills into the group-private Claude-plane skills dir', () => {
    const g = createAgentFromTemplate('sales/sdr', { name: 'SDR Skills' });

    const skill = path.join(DATA_DIR, 'v2-sessions', g.id, '.claude-shared', 'skills', 'widget', 'SKILL.md');
    expect(fs.existsSync(skill)).toBe(true);
  });

  it('writes MCP servers to the container config and context extras at their template-relative paths', () => {
    const g = createAgentFromTemplate('sales/sdr', { name: 'SDR Mcp' });

    const cfg = getContainerConfig(g.id);
    expect(cfg).toBeTruthy();
    expect(JSON.parse(cfg!.mcp_servers)).toHaveProperty('hubspot');
    // Extras land relative to the group root, exactly as they sit relative to
    // instructions.md in the template — no context/ prefix in between.
    const groupDir = path.join(GROUPS_DIR, g.folder);
    expect(fs.existsSync(path.join(groupDir, 'playbook.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'additional_context', 'faq.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'context'))).toBe(false);
  });

  it('creates an Agent Plugin without changing legacy creation behavior', () => {
    writePluginTemplate();

    const g = createAgentFromTemplate('lifestyle/family-assistant', { name: 'Family Assistant' });
    const groupDir = path.join(GROUPS_DIR, g.folder);

    expect(g.name).toBe('Family Assistant');
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('Family persona.\n');
    expect(fs.existsSync(path.join(groupDir, 'plugins', 'family-assistant', 'plugin.json'))).toBe(true);
    expect(
      fs.existsSync(path.join(groupDir, 'plugins', 'family-assistant', 'skills', 'family-assistant', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(DATA_DIR, 'v2-sessions', g.id, '.claude-shared', 'skills', 'family-assistant', 'SKILL.md'),
      ),
    ).toBe(true);

    const taskSession = getSessionsByAgentGroup(g.id).find((session) => session.thread_id?.startsWith('system:tasks:'));
    expect(taskSession).toBeDefined();
    const db = new Database(inboundDbPath(g.id, taskSession!.id), { readonly: true });
    const task = db.prepare("SELECT status, recurrence, content FROM messages_in WHERE kind = 'task'").get() as {
      status: string;
      recurrence: string;
      content: string;
    };
    db.close();
    expect(task.status).toBe('paused');
    expect(task.recurrence).toBe('0 7 * * *');
    expect(JSON.parse(task.content)).toMatchObject({ prompt: 'Send the morning brief.' });
  });
});
