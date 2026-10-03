import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import './members.js';

describe('members CLI', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);

    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-trip', 'Trip', 'trip', datetime('now')),
              ('ag-other', 'Other', 'other', datetime('now'))`,
    ).run();
    ensureContainerConfig('ag-trip');
    updateContainerConfigScalars('ag-trip', { cli_scope: 'group' });
    db.prepare(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES
         ('cli:alice', 'cli', 'Alice', datetime('now')),
         ('whatsapp:111@s.whatsapp.net', 'whatsapp', 'Alice A', datetime('now')),
         ('whatsapp:222@s.whatsapp.net', 'whatsapp', 'Frank', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES
         ('whatsapp:111@s.whatsapp.net', 'ag-trip', 'cli:alice', datetime('now')),
         ('whatsapp:222@s.whatsapp.net', 'ag-other', 'cli:alice', datetime('now'))`,
    ).run();
  });

  afterEach(() => {
    closeDb();
  });

  it('joins access members to their known display names', async () => {
    const response = await dispatch(
      { id: 'req-1', command: 'members-list', args: { agent_group_id: 'ag-trip' } },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).toEqual([
      expect.objectContaining({
        user_id: 'whatsapp:111@s.whatsapp.net',
        display_name: 'Alice A',
        kind: 'whatsapp',
        agent_group_id: 'ag-trip',
      }),
    ]);
  });

  it('keeps group-scoped agents inside their own access list', async () => {
    const response = await dispatch(
      { id: 'req-2', command: 'members-list', args: {} },
      {
        caller: 'agent',
        sessionId: 'sess-trip',
        agentGroupId: 'ag-trip',
        messagingGroupId: 'mg-trip',
      },
    );

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).toEqual([
      expect.objectContaining({
        user_id: 'whatsapp:111@s.whatsapp.net',
        display_name: 'Alice A',
        agent_group_id: 'ag-trip',
      }),
    ]);
  });
});
