import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(false),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-lifecycle' };
});

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { getSession } from './db/sessions.js';
import { openInboundDb } from './session-manager.js';
import { setAgentGroupDesiredState } from './agent-group-lifecycle.js';
import { wakeContainer } from './container-runner.js';
import type { InboundEvent } from './channels/adapter.js';

const TEST_DIR = '/tmp/nanoclaw-test-router-lifecycle';

describe('router lifecycle gate', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-router',
      name: 'Router test',
      folder: 'router-test',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-router',
      channel_type: 'discord',
      platform_id: 'router-channel',
      name: 'Router',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    createMessagingGroupAgent({
      id: 'mga-router',
      messaging_group_id: 'mg-router',
      agent_group_id: 'ag-router',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    vi.mocked(wakeContainer).mockClear();
  });

  it('queues a message without waking a paused group', async () => {
    setAgentGroupDesiredState('ag-router', 'paused', 'ops-center');
    const { routeInbound } = await import('./router.js');
    const event: InboundEvent = {
      channelType: 'discord',
      platformId: 'router-channel',
      threadId: null,
      message: {
        id: 'router-message-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'operator', text: 'keep this queued' }),
        timestamp: new Date().toISOString(),
      },
    };

    await routeInbound(event);

    const session = getSession((await import('./db/sessions.js')).findSession('mg-router', null)!.id)!;
    const db = openInboundDb('ag-router', session.id);
    try {
      expect(db.prepare("SELECT status, trigger FROM messages_in WHERE kind = 'chat'").get()).toEqual({
        status: 'pending',
        trigger: 1,
      });
    } finally {
      db.close();
    }
    expect(wakeContainer).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'message');
  });

  it('passes a stopped group message to the host wake path so it can resume', async () => {
    setAgentGroupDesiredState('ag-router', 'stopped', 'ops-center');
    vi.mocked(wakeContainer).mockResolvedValueOnce(true);
    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'discord',
      platformId: 'router-channel',
      threadId: null,
      message: {
        id: 'router-message-stopped',
        kind: 'chat',
        content: JSON.stringify({ sender: 'operator', text: 'wake after stop' }),
        timestamp: new Date().toISOString(),
      },
    });

    expect(wakeContainer).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'message');
  });
});
