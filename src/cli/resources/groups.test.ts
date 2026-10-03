/**
 * Regression test for #2525 — `ncl groups delete` must cascade dependent
 * rows in FK order so the final `DELETE FROM agent_groups` succeeds even
 * when the group has sessions, destinations, approvals, role grants, etc.
 *
 * The bug pre-fix: the generic single-table DELETE handler ran a bare
 * `DELETE FROM agent_groups WHERE id = ?` which always failed with a
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when anything pointed at the group.
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so the test invokes dispatch
 * with the host caller — same code path a real approval would take.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const runnerMocks = vi.hoisted(() => ({
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));
const imageMocks = vi.hoisted(() => ({
  rebuildBaseImage: vi.fn().mockResolvedValue('test-build-fingerprint'),
}));
const restartMocks = vi.hoisted(() => ({
  restartAgentGroupContainers: vi.fn().mockReturnValue(0),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: runnerMocks.buildAgentGroupImage,
}));

vi.mock('../../container-image.js', () => ({
  rebuildBaseImage: imageMocks.rebuildBaseImage,
}));

vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: restartMocks.restartAgentGroupContainers,
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-groups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including delete).
import './groups.js';

function now(): string {
  return new Date().toISOString();
}

function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

describe('groups CLI delete cascades dependent rows (#2525)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('deletes a group with sessions, destinations, approvals, members, roles, and wirings', async () => {
    const GID = 'ag-victim';
    const SID = 'sess-victim-1';
    const MGID = 'mg-1';
    const UID = 'tg:42';

    createAgentGroup({ id: GID, name: 'victim', folder: 'victim', agent_provider: null, created_at: now() });
    createSession({
      id: SID,
      agent_group_id: GID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    const db = getDb();

    // Direct inserts for the dependent tables. Keeps the fixture minimal —
    // we only need rows that establish FK relationships, not full domain
    // entities.
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`).run(
      UID,
      now(),
    );
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
    ).run(MGID, now());

    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'chan', 'channel', ?, ?)`,
    ).run(GID, MGID, now());

    db.prepare(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES (?, ?, 'mout-1', 'q', '[]', ?)`,
    ).run('q-1', SID, now());

    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status, title, options_json)
       VALUES (?, ?, 'req-1', 'cli_command', '{}', ?, ?, 'pending', '', '[]')`,
    ).run('pa-1', SID, now(), GID);

    db.prepare(
      `INSERT INTO pending_sender_approvals (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message, approver_user_id, created_at)
       VALUES ('psa-1', ?, ?, 'tg:99', 'them', '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-1', ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
    ).run(MGID, GID, now());

    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
    ).run(UID, GID, now());

    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
    ).run(UID, GID, now());

    // Container config row exercises the ON DELETE CASCADE on container_configs.
    db.prepare(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
    ).run(GID, now());

    const resp = await dispatch({ id: 'req-del', command: 'groups-delete', args: { id: GID } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { deleted: string; removed: Record<string, number> } }).data;
    expect(data.deleted).toBe(GID);
    expect(data.removed).toMatchObject({
      sessions: 1,
      pending_questions: 1,
      pending_approvals: 1,
      agent_destinations_owned: 1,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 1,
      pending_channel_approvals: 1,
      messaging_group_agents: 1,
      agent_group_members: 1,
      user_roles: 1,
      container_configs: 1,
    });

    // The group and every dependent row must be gone.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM sessions WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_questions WHERE session_id = ?', SID)).toBe(0);
    expect(
      count('SELECT COUNT(*) AS c FROM pending_approvals WHERE agent_group_id = ? OR session_id = ?', GID, SID),
    ).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_group_members WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM user_roles WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM container_configs WHERE agent_group_id = ?', GID)).toBe(0);

    // Unrelated tables untouched.
    expect(count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MGID)).toBe(1);
  });

  it('removes polymorphic agent_destinations that point at the deleted group', async () => {
    const A = 'ag-a';
    const B = 'ag-b';
    createAgentGroup({ id: A, name: 'a', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'b', folder: 'b', agent_provider: null, created_at: now() });

    const db = getDb();

    // B has a destination pointing at A. target_id is polymorphic — no FK
    // constraint enforces it, so without explicit cleanup the row would
    // dangle after A is deleted.
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'sibling', 'agent', ?, ?)`,
    ).run(B, A, now());

    const resp = await dispatch({ id: 'req-del-a', command: 'groups-delete', args: { id: A } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.agent_destinations_pointing).toBe(1);

    // A is gone, B remains, and B's stale destination is cleaned up.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', A)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', B)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', B)).toBe(0);
  });

  it('returns a handler error for an unknown group id', async () => {
    const resp = await dispatch(
      { id: 'req-missing', command: 'groups-delete', args: { id: 'ag-does-not-exist' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error.code).toBe('handler-error');
    expect((resp as { ok: false; error: { code: string; message: string } }).error.message).toMatch(/not found/i);
  });
});

describe('groups config set-skills', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  const seed = (gid: string) => {
    createAgentGroup({ id: gid, name: gid, folder: gid, agent_provider: null, created_at: now() });
    getDb()
      .prepare(
        `INSERT INTO container_configs
           (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
            skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
         VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      )
      .run(gid, now());
  };
  const skillsCol = (gid: string): string =>
    (getDb().prepare('SELECT skills FROM container_configs WHERE agent_group_id = ?').get(gid) as { skills: string })
      .skills;

  it('writes an explicit JSON-array selection', async () => {
    seed('ag-s1');
    const resp = await dispatch(
      { id: 'r1', command: 'groups-config-set-skills', args: { id: 'ag-s1', skills: '["trip-core","trip-finance"]' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect(JSON.parse(skillsCol('ag-s1'))).toEqual(['trip-core', 'trip-finance']);
  });

  it('writes "all" to restore the dynamic selection', async () => {
    seed('ag-s2');
    getDb().prepare(`UPDATE container_configs SET skills = '["trip-core"]' WHERE agent_group_id = ?`).run('ag-s2');
    const resp = await dispatch(
      { id: 'r2', command: 'groups-config-set-skills', args: { id: 'ag-s2', skills: 'all' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect(JSON.parse(skillsCol('ag-s2'))).toBe('all');
  });

  it('dedupes array entries and rejects malformed / missing input', async () => {
    seed('ag-s3');
    const dup = await dispatch(
      { id: 'r3', command: 'groups-config-set-skills', args: { id: 'ag-s3', skills: '["a","a","b"]' } },
      { caller: 'host' },
    );
    expect(dup.ok).toBe(true);
    expect(JSON.parse(skillsCol('ag-s3'))).toEqual(['a', 'b']);

    expect(
      (
        await dispatch(
          { id: 'r4', command: 'groups-config-set-skills', args: { id: 'ag-s3', skills: 'not-json' } },
          { caller: 'host' },
        )
      ).ok,
    ).toBe(false);

    expect(
      (await dispatch({ id: 'r5', command: 'groups-config-set-skills', args: { id: 'ag-s3' } }, { caller: 'host' })).ok,
    ).toBe(false);
  });
});

describe('groups config update hardening hub access', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  const seed = (gid: string) => {
    createAgentGroup({ id: gid, name: gid, folder: gid, agent_provider: null, created_at: now() });
    getDb()
      .prepare(
        `INSERT INTO container_configs
           (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
            skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
         VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      )
      .run(gid, now());
  };

  it.each(['read-write', 'read-only', 'none'])('accepts hubAccess=%s', async (hubAccess) => {
    seed(`ag-hub-${hubAccess}`);
    const resp = await dispatch(
      {
        id: `hub-${hubAccess}`,
        command: 'groups-config-update',
        args: {
          id: `ag-hub-${hubAccess}`,
          hardening: JSON.stringify({ egress: false, scrub: true, hubAccess }),
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const row = getDb()
      .prepare('SELECT hardening FROM container_configs WHERE agent_group_id = ?')
      .get(`ag-hub-${hubAccess}`) as { hardening: string };
    expect(JSON.parse(row.hardening)).toMatchObject({ hubAccess });
  });

  it('rejects an unknown hubAccess value', async () => {
    seed('ag-hub-invalid');
    const resp = await dispatch(
      {
        id: 'hub-invalid',
        command: 'groups-config-update',
        args: {
          id: 'ag-hub-invalid',
          hardening: JSON.stringify({ egress: false, hubAccess: 'sometimes' }),
        },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toContain('hubAccess');
  });
});

describe('groups config update model canonicalization', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  function seed(gid: string): void {
    createAgentGroup({ id: gid, name: gid, folder: gid, agent_provider: null, created_at: now() });
    getDb()
      .prepare(
        `INSERT INTO container_configs
           (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
            skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
         VALUES (?, 'claude', 'gpt-5.6-terra', NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      )
      .run(gid, now());
  }

  it('accepts none as an explicit scalar-model clear', async () => {
    seed('ag-model-clear');
    const response = await dispatch(
      { id: 'model-clear', command: 'groups-config-update', args: { id: 'ag-model-clear', model: 'none' } },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    expect(
      (
        getDb().prepare('SELECT model FROM container_configs WHERE agent_group_id = ?').get('ag-model-clear') as {
          model: string | null;
        }
      ).model,
    ).toBeNull();
  });

  it('clears a stale scalar model when tier routing becomes active', async () => {
    seed('ag-tier-canonical');
    const response = await dispatch(
      {
        id: 'tier-canonical',
        command: 'groups-config-update',
        args: {
          id: 'ag-tier-canonical',
          'model-tiers': JSON.stringify({
            high: 'claude-sonnet-5',
            medium: 'claude-sonnet-4-6',
            low: 'haiku',
            default: 'medium',
          }),
        },
      },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    const row = getDb()
      .prepare('SELECT model, model_tiers FROM container_configs WHERE agent_group_id = ?')
      .get('ag-tier-canonical') as { model: string | null; model_tiers: string };
    expect(row.model).toBeNull();
    expect(JSON.parse(row.model_tiers)).toMatchObject({ medium: 'claude-sonnet-4-6', default: 'medium' });
  });

  it('accepts native XAI tiers for an OpenCode group', async () => {
    seed('ag-grok-tier-validation');
    getDb()
      .prepare("UPDATE container_configs SET provider = 'opencode', model = 'xai/grok-4.6' WHERE agent_group_id = ?")
      .run('ag-grok-tier-validation');
    fs.writeFileSync(
      `${TEST_DIR}/model-catalog.json`,
      JSON.stringify({
        fetchedAt: Date.now(),
        source: 'test-openrouter-only',
        models: [
          {
            id: 'openrouter/minimax/minimax-m3',
            name: 'MiniMax M3',
            contextWindow: 128000,
            toolCapable: true,
            promptCost: 1,
            completionCost: 1,
            intelligenceIndex: 1,
          },
        ],
      }),
    );

    const response = await dispatch(
      {
        id: 'grok-tier-validation',
        command: 'groups-config-update',
        args: {
          id: 'ag-grok-tier-validation',
          'model-tiers': JSON.stringify({
            high: 'xai/grok-4.6',
            medium: 'xai/grok-4.5',
            low: 'xai/grok-4.3',
            default: 'medium',
          }),
        },
      },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    const row = getDb()
      .prepare('SELECT model, model_tiers FROM container_configs WHERE agent_group_id = ?')
      .get('ag-grok-tier-validation') as { model: string | null; model_tiers: string };
    expect(row.model).toBeNull();
    expect(JSON.parse(row.model_tiers)).toMatchObject({
      high: 'xai/grok-4.6',
      medium: 'xai/grok-4.5',
      low: 'xai/grok-4.3',
      default: 'medium',
    });
  });

  it('rejects unsupported native Codex tier ids', async () => {
    seed('ag-codex-tier-validation');
    getDb()
      .prepare("UPDATE container_configs SET provider = 'codex', model = NULL WHERE agent_group_id = ?")
      .run('ag-codex-tier-validation');

    const response = await dispatch(
      {
        id: 'codex-tier-validation',
        command: 'groups-config-update',
        args: {
          id: 'ag-codex-tier-validation',
          'model-tiers': JSON.stringify({
            high: 'gpt-6-sol',
            medium: 'gpt-6-sol',
            low: 'gpt-5.6-luna',
            default: 'medium',
          }),
        },
      },
      { caller: 'host' },
    );

    expect(response.ok).toBe(false);
    expect((response as { ok: false; error: { message: string } }).error.message).toContain(
      'not a supported Codex model id',
    );
  });

  it('rejects unsupported scalar Codex model ids', async () => {
    seed('ag-codex-model-validation');
    getDb()
      .prepare("UPDATE container_configs SET provider = 'codex' WHERE agent_group_id = ?")
      .run('ag-codex-model-validation');

    const response = await dispatch(
      {
        id: 'codex-model-validation',
        command: 'groups-config-update',
        args: { id: 'ag-codex-model-validation', model: 'gpt-6-sol' },
      },
      { caller: 'host' },
    );

    expect(response.ok).toBe(false);
    expect((response as { ok: false; error: { message: string } }).error.message).toContain(
      'not a supported Codex model id',
    );
  });
});

describe('groups restart image selection', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  function seed(gid: string, packagesApt = '[]', packagesNpm = '[]'): void {
    createAgentGroup({ id: gid, name: gid, folder: gid, agent_provider: null, created_at: now() });
    getDb()
      .prepare(
        `INSERT INTO container_configs
           (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
            skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
         VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', ?, ?, '[]', 'group', ?)`,
      )
      .run(gid, packagesApt, packagesNpm, now());
  }

  it('rebuilds the shared image for a group with no package additions', async () => {
    seed('ag-shared-image');

    const response = await dispatch(
      { id: 'restart-shared', command: 'groups-restart', args: { id: 'ag-shared-image', rebuild: true } },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    expect(imageMocks.rebuildBaseImage).toHaveBeenCalledOnce();
    expect(runnerMocks.buildAgentGroupImage).not.toHaveBeenCalled();
    expect(restartMocks.restartAgentGroupContainers).toHaveBeenCalledWith(
      'ag-shared-image',
      'restarted via ncl',
      undefined,
      false,
    );
  });

  it('keeps the per-group image builder for package-configured groups', async () => {
    seed('ag-custom-image', '["libreoffice"]');

    const response = await dispatch(
      { id: 'restart-custom', command: 'groups-restart', args: { id: 'ag-custom-image', rebuild: true } },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    expect(runnerMocks.buildAgentGroupImage).toHaveBeenCalledOnce();
    expect(imageMocks.rebuildBaseImage).not.toHaveBeenCalled();
  });
});
