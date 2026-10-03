import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider } from './providers/types.js';
import { clearCurrentConsultationCapture } from './consult-correlation.js';

let dir: string;
let stateDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-consult-correlation-'));
  stateDir = path.join(dir, 'consultations');
  process.env.NANOCLAW_CONSULT_SKILL_SCRIPT = path.resolve(
    process.cwd(),
    'container/skills/consult/scripts/consult.mjs',
  );
  process.env.NANOCLAW_CONSULT_STATE_DIR = stateDir;
  initTestSessionDb({ heartbeatPath: path.join(dir, '.heartbeat') });
});

afterEach(() => {
  clearCurrentConsultationCapture();
  closeSessionDb();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.NANOCLAW_CONSULT_SKILL_SCRIPT;
  delete process.env.NANOCLAW_CONSULT_STATE_DIR;
});

describe('consultation outbound correlation', () => {
  it('attaches the request correlation and actual local model receipt before an answer leaves the target container', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('consult-request', 'chat', datetime('now'), 'pending', 'jeeves', 'agent', ?)`,
      )
      .run(JSON.stringify({
        text: '[consultation C001 · C001:A0]\nQuestion',
        consult: {
          kind: 'request',
          version: 1,
          rootId: 'C001',
          rootTag: 'fixture',
          questionNodeId: 'C001:Q0',
          answerNodeId: 'C001:A0',
          requestId: 'req-fixture',
          modelMode: 'default',
          requestedTier: null,
        },
      }));

    writeMessageOut({
      id: 'answer',
      in_reply_to: 'consult-request',
      kind: 'chat',
      platform_id: 'jeeves',
      channel_type: 'agent',
      content: JSON.stringify({ text: 'Exact fixture answer.' }),
    });

    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.text).toBe('Exact fixture answer.');
    expect(content.consult).toMatchObject({
      kind: 'response',
      rootId: 'C001',
      answerNodeId: 'C001:A0',
      requestId: 'req-fixture',
      modelMode: 'default',
    });
    expect(content.consult.responder.providerName).toBe('claude');
    expect(content.consult.responder.configuredModel).toBe('sonnet');
  });

  it('archives the invoking model output as a separate processed graph node through the real poll loop', async () => {
    const rootDir = path.join(stateDir, 'roots', 'C001');
    fs.mkdirSync(path.join(rootDir, 'content'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'content', 'Q0.txt'), 'Fixture question');
    fs.writeFileSync(path.join(stateDir, 'index.json'), JSON.stringify({
      version: 1,
      nextRoot: 2,
      activeRootId: 'C001',
      recentOpen: ['C001'],
      closed: [],
      trash: [],
      profile: {},
      roster: {},
    }));
    fs.writeFileSync(path.join(rootDir, 'root.json'), JSON.stringify({
      version: 1,
      id: 'C001',
      tag: 'fixture',
      status: 'open',
      protocol: 'quick',
      defaultLens: 'distill',
      createdAt: '2026-08-23T10:00:00.000Z',
      updatedAt: '2026-08-23T10:00:00.000Z',
      questionNodeId: 'C001:Q0',
    }));
    fs.writeFileSync(path.join(rootDir, 'graph.json'), JSON.stringify({
      version: 1,
      rootId: 'C001',
      nodes: [
        { id: 'C001:Q0', type: 'question', status: 'complete', contentPath: 'content/Q0.txt' },
        { id: 'C001:S0', type: 'synthesis', status: 'pending', lens: 'distill', contentPath: null },
      ],
      edges: [{ from: 'C001:Q0', to: 'C001:S0', type: 'derives' }],
    }));
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('family', 'Family', 'channel', 'whatsapp', 'family-chat', NULL)`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('synthesis-request', 'chat', datetime('now'), 'pending', 'family-chat', 'whatsapp', ?)`,
      )
      .run(JSON.stringify({
        text: 'Produce the fixture synthesis.',
        consult: { kind: 'synthesis-request', version: 1, rootId: 'C001', nodeId: 'C001:S0', lens: 'distill' },
      }));

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query: () => ({
        push: () => {},
        end: () => {},
        abort: () => {},
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'init' as const, continuation: 'fixture-continuation' };
            yield { type: 'result' as const, text: '<message to="family">Processed fixture synthesis.</message>' };
          },
        },
      }),
    };
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerName: 'claude',
      configuredModel: 'sonnet',
      effort: 'high',
      agentGroupId: 'jeeves',
      cwd: '/tmp',
      assistantName: 'Jeeves',
      skillsDir: dir,
      signal: controller.signal,
    });

    await waitFor(() => fs.existsSync(path.join(rootDir, 'content', 'S0.txt')), 3000);
    controller.abort();
    await loop;

    expect(fs.readFileSync(path.join(rootDir, 'content', 'S0.txt'), 'utf8')).toBe('Processed fixture synthesis.');
    const graph = JSON.parse(fs.readFileSync(path.join(rootDir, 'graph.json'), 'utf8'));
    expect(graph.nodes.find((node: { id: string }) => node.id === 'C001:S0')).toMatchObject({
      status: 'complete',
      contentPath: 'content/S0.txt',
    });
  });

  it('captures and processes a consulted answer that arrives while another provider turn is active', async () => {
    const rootDir = seedPendingAnswerRoot();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('family', 'Family', 'channel', 'whatsapp', 'family-chat', NULL)`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('initial-user-turn', 'chat', datetime('now'), 'pending', 'family-chat', 'whatsapp', ?)`,
      )
      .run(JSON.stringify({ text: 'Keep working while the consultation returns.' }));

    let stopQuery: (() => void) | null = null;
    const seenPrompts: string[] = [];
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query: (queryInput) => {
        const pending: string[] = [];
        let wake: (() => void) | null = null;
        let ended = false;
        stopQuery = () => { ended = true; wake?.(); };
        return {
          push: (prompt) => { pending.push(prompt); wake?.(); },
          end: () => stopQuery?.(),
          abort: () => stopQuery?.(),
          events: {
            async *[Symbol.asyncIterator]() {
              seenPrompts.push(queryInput.prompt);
              yield { type: 'result' as const, text: '<message to="family">Initial fixture response.</message>' };
              while (!ended) {
                if (pending.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
                wake = null;
                while (pending.length) {
                  const prompt = pending.shift()!;
                  seenPrompts.push(prompt);
                  yield { type: 'result' as const, text: '<message to="family">Processed returning consultation.</message>' };
                }
              }
            },
          },
        };
      },
    };
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerName: 'claude',
      configuredModel: 'sonnet',
      effort: 'high',
      agentGroupId: 'jeeves',
      cwd: '/tmp',
      assistantName: 'Jeeves',
      skillsDir: dir,
      signal: controller.signal,
    });
    await waitFor(() => getUndeliveredMessages().length >= 1, 3000);

    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('returning-answer', 'chat', datetime('now'), 'pending', 1, 'errand-runner', 'agent', ?)`,
      )
      .run(JSON.stringify({
        text: 'Exact answer returned during the open stream.',
        consult: {
          kind: 'response',
          version: 1,
          rootId: 'C001',
          questionNodeId: 'C001:Q0',
          answerNodeId: 'C001:A0',
          requestId: 'req-active',
          responder: {
            assistantName: 'Errand Runner',
            agentGroupId: 'errand-runner',
            providerName: 'opencode',
            configuredModel: 'deepseek/deepseek-v4-flash',
            modelKey: 'deepseek-deepseek-v4-flash',
          },
        },
      }));

    await waitFor(() => fs.existsSync(path.join(rootDir, 'content', 'S1.txt')), 4000);
    stopQuery?.();
    controller.abort();
    await loop;

    expect(fs.readFileSync(path.join(rootDir, 'content', 'A0.txt'), 'utf8')).toBe(
      'Exact answer returned during the open stream.',
    );
    expect(fs.readFileSync(path.join(rootDir, 'content', 'S1.txt'), 'utf8')).toBe(
      'Processed returning consultation.',
    );
    expect(seenPrompts.some((prompt) => prompt.includes('Distilled synthesis'))).toBe(true);
  });
});

function seedPendingAnswerRoot(): string {
  const rootDir = path.join(stateDir, 'roots', 'C001');
  fs.mkdirSync(path.join(rootDir, 'content'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'content', 'Q0.txt'), 'Fixture question');
  fs.writeFileSync(path.join(stateDir, 'index.json'), JSON.stringify({
    version: 1,
    nextRoot: 2,
    activeRootId: 'C001',
    recentOpen: ['C001'],
    closed: [],
    trash: [],
    profile: {},
    roster: {},
  }));
  fs.writeFileSync(path.join(rootDir, 'root.json'), JSON.stringify({
    version: 1,
    id: 'C001',
    tag: 'active-answer',
    status: 'open',
    protocol: 'quick',
    defaultLens: 'distill',
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
    questionNodeId: 'C001:Q0',
  }));
  fs.writeFileSync(path.join(rootDir, 'graph.json'), JSON.stringify({
    version: 1,
    rootId: 'C001',
    nodes: [
      { id: 'C001:Q0', type: 'question', status: 'complete', contentPath: 'content/Q0.txt' },
      { id: 'C001:A0', type: 'answer', status: 'pending', questionNodeId: 'C001:Q0', requestId: 'req-active', contentPath: null },
    ],
    edges: [{ from: 'C001:Q0', to: 'C001:A0', type: 'answers' }],
  }));
  return rootDir;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
