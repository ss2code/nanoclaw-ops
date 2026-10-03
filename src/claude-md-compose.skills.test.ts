import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
let tempDir: string | null = null;

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  vi.resetModules();
});

describe('composeGroupClaudeMd', () => {
  it('imports instructions.md only for enabled skills when skills is scoped', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-compose-'));
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, 'container', 'skills', 'trip-core'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'container', 'skills', 'unrelated-app'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'container', 'skills', 'trip-core', 'instructions.md'), 'trip rules');
    fs.writeFileSync(path.join(tempDir, 'container', 'skills', 'unrelated-app', 'instructions.md'), 'other rules');

    const db = await import('./db/index.js');
    const groups = await import('./db/agent-groups.js');
    const configs = await import('./db/container-configs.js');
    const compose = await import('./claude-md-compose.js');

    db.initTestDb();
    db.runMigrations(db.getDb());
    groups.createAgentGroup({
      id: 'ag-trip',
      name: 'Trip',
      folder: 'trip',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00',
    });
    configs.ensureContainerConfig('ag-trip');
    configs.updateContainerConfigJson('ag-trip', 'skills', ['trip-core']);

    compose.composeGroupClaudeMd({
      id: 'ag-trip',
      name: 'Trip',
      folder: 'trip',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00',
    });

    const composed = fs.readFileSync(path.join(tempDir, 'groups', 'trip', 'CLAUDE.md'), 'utf8');
    expect(composed).toContain('@./.claude-fragments/skill-trip-core.md');
    expect(composed).not.toContain('skill-unrelated-app.md');
  });

  it('imports finance and memory instructions when a group enables the skills', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-compose-'));
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, 'container', 'skills', 'finance'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'container', 'skills', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'container', 'skills', 'finance', 'instructions.md'), 'finance rules');
    fs.writeFileSync(path.join(tempDir, 'container', 'skills', 'memory', 'instructions.md'), 'memory rules');

    const db = await import('./db/index.js');
    const groups = await import('./db/agent-groups.js');
    const configs = await import('./db/container-configs.js');
    const compose = await import('./claude-md-compose.js');

    db.initTestDb();
    db.runMigrations(db.getDb());
    groups.createAgentGroup({
      id: 'ag-fixture',
      name: 'Fixture',
      folder: 'fixture',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00',
    });
    configs.ensureContainerConfig('ag-fixture');
    configs.updateContainerConfigJson('ag-fixture', 'skills', ['finance', 'memory']);

    compose.composeGroupClaudeMd({
      id: 'ag-fixture',
      name: 'Fixture',
      folder: 'fixture',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00',
    });

    const composed = fs.readFileSync(path.join(tempDir, 'groups', 'fixture', 'CLAUDE.md'), 'utf8');
    expect(composed).toContain('@./.claude-fragments/skill-finance.md');
    expect(composed).toContain('@./.claude-fragments/skill-memory.md');
  });

  it('imports daily-update instructions when the assistant group enables the skill', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-compose-'));
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, 'container', 'skills', 'daily-update'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'container', 'skills', 'finance'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'container', 'skills', 'daily-update', 'instructions.md'), 'daily rules');
    fs.writeFileSync(path.join(tempDir, 'container', 'skills', 'finance', 'instructions.md'), 'finance rules');

    const db = await import('./db/index.js');
    const groups = await import('./db/agent-groups.js');
    const configs = await import('./db/container-configs.js');
    const compose = await import('./claude-md-compose.js');

    db.initTestDb();
    db.runMigrations(db.getDb());
    groups.createAgentGroup({
      id: 'ag-assistant',
      name: 'Assistant',
      folder: 'test-group',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00',
    });
    configs.ensureContainerConfig('ag-assistant');
    configs.updateContainerConfigJson('ag-assistant', 'skills', ['daily-update', 'finance']);

    compose.composeGroupClaudeMd({
      id: 'ag-assistant',
      name: 'Assistant',
      folder: 'test-group',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00',
    });

    const composed = fs.readFileSync(path.join(tempDir, 'groups', 'test-group', 'CLAUDE.md'), 'utf8');
    expect(composed).toContain('@./.claude-fragments/skill-daily-update.md');
    expect(composed).toContain('@./.claude-fragments/skill-finance.md');
  });
});
