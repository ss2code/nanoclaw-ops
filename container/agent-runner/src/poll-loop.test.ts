import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import {
  RetryableProviderStallError,
  RetryableResponseFormatError,
  RetryableProviderStreamClosedError,
  hasWakeTrigger,
  hasScheduledTask,
  getScheduledDelegation,
  buildScheduledDelegationPrompt,
  isCorruptionError,
  processQuery,
  SUBAGENT_NOTICE_BATCH_MS,
} from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
    expect(prompt).toContain('scheduled tasks involving web browsing');
    expect(prompt).toContain('MUST delegate');
    expect(prompt).toContain('LOW model tier');
    expect(prompt).toContain('model="low"');
    expect(prompt).toContain('parent model MUST inspect and verify');
    expect(prompt).not.toContain('haiku');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(hasWakeTrigger(messages)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(hasWakeTrigger(messages)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('active follow-up gate skips trigger=0-only batches', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'ambient chatter' }, { trigger: 0 });
    const followUps = getPendingMessages().filter((m) => m.kind !== 'system');
    expect(hasWakeTrigger(followUps)).toBe(false);
  });

  it('active follow-up gate allows mixed batches so accumulated context rides along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'ambient chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: '@bot actual question' }, { trigger: 1 });
    const followUps = getPendingMessages().filter((m) => m.kind !== 'system');
    expect(hasWakeTrigger(followUps)).toBe(true);
    expect(followUps.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('scheduled-task isolation', () => {
  it('recognizes task batches as scheduled work that needs a fresh continuation', () => {
    expect(hasScheduledTask([{ kind: 'chat' }, { kind: 'task' }])).toBe(true);
    expect(hasScheduledTask([{ kind: 'chat' }, { kind: 'webhook' }])).toBe(false);
  });

  it('recognizes only an explicit Errand Runner schedule handoff', () => {
    expect(
      getScheduledDelegation({
        id: 'task-errand',
        kind: 'task',
        content: JSON.stringify({ prompt: 'fetch public sources', delegateTo: 'errand-runner' }),
      } as any),
    ).toBe('errand-runner');
    expect(
      getScheduledDelegation({
        id: 'task-jeeves',
        kind: 'task',
        content: JSON.stringify({ prompt: 'review private memory' }),
      } as any),
    ).toBeNull();
  });

  it('builds a self-contained handoff that keeps final delivery with Jeeves', () => {
    const prompt = buildScheduledDelegationPrompt({
      id: 'task-errand',
      kind: 'task',
      content: JSON.stringify({
        prompt: 'research public prices',
        scriptOutput: { rows: 2 },
        delegateTo: 'errand-runner',
      }),
    } as any);
    expect(prompt).toContain('[scheduled-task id=task-errand]');
    expect(prompt).toContain('research public prices');
    expect(prompt).toContain('Jeeves owns final synthesis and delivery');
    expect(prompt).toContain('scriptOutput');
    expect(prompt).not.toMatch(/\[tier:\s*(?:high|medium|low)\s*\]/i);
  });

  it('preserves a tier directive only when the scheduled request explicitly includes one', () => {
    const prompt = buildScheduledDelegationPrompt({
      id: 'task-explicit-tier',
      kind: 'task',
      content: JSON.stringify({
        prompt: '[tier:low] research public prices',
        delegateTo: 'errand-runner',
      }),
    } as any);
    expect(prompt).toContain('[tier:low]');
    expect(prompt).toContain('research public prices');
    expect(prompt.match(/\[tier:\s*(?:high|medium|low)\s*\]/gi) ?? []).toHaveLength(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(
    id: string,
    kind: string,
    content: object,
    channelType: string | null,
    platformId: string | null,
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

function makeEventQuery(...results: ProviderEvent[]): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    for (const result of results) yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => pushes.push(m),
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

class ControlledEventStream implements AsyncIterable<ProviderEvent> {
  private queued: ProviderEvent[] = [];
  private waiters: Array<(result: IteratorResult<ProviderEvent>) => void> = [];
  private closed = false;

  emit(event: ProviderEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queued.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: () => {
        const event = this.queued.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function makeControlledQuery(pushDisposition?: 'separate' | 'coalesced'): {
  query: AgentQuery;
  events: ControlledEventStream;
  pushes: string[];
  aborted: () => boolean;
} {
  const events = new ControlledEventStream();
  const pushes: string[] = [];
  let wasAborted = false;
  return {
    events,
    pushes,
    aborted: () => wasAborted,
    query: {
      push: (message: string) => {
        pushes.push(message);
        return pushDisposition;
      },
      end: () => events.close(),
      events,
      abort: () => {
        wasAborted = true;
        events.close();
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await Bun.sleep(10);
  }
}

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

function markClaimProcessing(messageId = 'm1'): void {
  getOutboundDb()
    .prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
    )
    .run(messageId);
}

function ackStatus(messageId = 'm1'): string {
  const ack = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(messageId) as
    | { status: string }
    | undefined;
  return ack?.status ?? 'missing';
}

describe('subagent spawn chat notices', () => {
  it('coalesces a same-model fan-out into one concise summary', async () => {
    markClaimProcessing();
    const spawns: ProviderEvent[] = Array.from({ length: 11 }, (_, index) => ({
      type: 'subagent_spawn',
      model: 'haiku',
      reason: `Triage section ${index + 1}`,
    }));
    const { query } = makeEventQuery(...spawns, { type: 'result', text: '<internal>Triage complete.</internal>' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('[haiku ×11 — Triage section 1; +10 more]');
  });

  it('keeps the existing notice shape for an isolated spawn', async () => {
    markClaimProcessing();
    const { query } = makeEventQuery(
      { type: 'subagent_spawn', model: 'haiku', reason: 'Find Bay Area news via web search' },
      { type: 'result', text: '<internal>Lookup complete.</internal>' },
    );

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('[haiku — Find Bay Area news via web search]');
  });

  it('summarizes mixed-model fan-out without dropping model counts', async () => {
    markClaimProcessing();
    const { query } = makeEventQuery(
      { type: 'subagent_spawn', model: 'haiku', reason: 'Quick lookup one' },
      { type: 'subagent_spawn', model: 'opus', reason: 'Architecture review' },
      { type: 'subagent_spawn', model: 'haiku', reason: 'Quick lookup two' },
      { type: 'result', text: '<internal>Delegation complete.</internal>' },
    );

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('[3 subagents — haiku ×2, opus ×1]');
  });

  it('emits the summary after a quiet window while the outer turn is still running', async () => {
    markClaimProcessing();
    const controlled = makeControlledQuery();
    controlled.events.emit({ type: 'init', continuation: 'sess-1' });
    controlled.events.emit({ type: 'subagent_spawn', model: 'haiku', reason: 'Parallel lookup one' });
    controlled.events.emit({ type: 'subagent_spawn', model: 'haiku', reason: 'Parallel lookup two' });

    const running = processQuery(
      controlled.query,
      ERR_ROUTING,
      ['m1'],
      'claude',
      '/tmp',
      undefined,
      'prompt',
      undefined,
      undefined,
      120_000,
      20,
    );

    await Bun.sleep(60);
    const beforeResult = getUndeliveredMessages();
    controlled.events.emit({ type: 'result', text: '<internal>Outer turn complete.</internal>' });
    controlled.events.close();
    await running;

    expect(beforeResult).toHaveLength(1);
    expect(JSON.parse(beforeResult[0].content).text).toBe('[haiku ×2 — Parallel lookup one; +1 more]');
  });

  it('keeps explicit tier-switch notices immediate', async () => {
    markClaimProcessing();
    const controlled = makeControlledQuery();
    controlled.events.emit({ type: 'init', continuation: 'sess-1' });
    controlled.events.emit({
      type: 'subagent_spawn',
      model: 'claude-opus-4-8',
      reason: 'tier:high directive',
      noticeMode: 'immediate',
    });

    const running = processQuery(
      controlled.query,
      ERR_ROUTING,
      ['m1'],
      'claude',
      '/tmp',
      undefined,
      'prompt',
      undefined,
      undefined,
      120_000,
      60_000,
    );

    await waitFor(() => getUndeliveredMessages().length === 1);
    const beforeResult = getUndeliveredMessages();
    controlled.events.emit({ type: 'result', text: '<internal>Tiered turn complete.</internal>' });
    controlled.events.close();
    await running;

    expect(JSON.parse(beforeResult[0].content).text).toBe('[claude-opus-4-8 — tier:high directive]');
  });

  it('keeps subagent notices out of agent-to-agent channels', async () => {
    markClaimProcessing();
    const { query } = makeEventQuery(
      { type: 'subagent_spawn', model: 'haiku', reason: 'Peer lookup one' },
      { type: 'subagent_spawn', model: 'haiku', reason: 'Peer lookup two' },
      { type: 'result', text: '<internal>Peer work complete.</internal>' },
    );

    await processQuery(
      query,
      { ...ERR_ROUTING, channelType: 'agent' },
      ['m1'],
      'claude',
      '/tmp',
      undefined,
      'prompt',
      undefined,
    );

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('flushes one pending summary when the provider stream closes early', async () => {
    markClaimProcessing();
    const { query } = makeEventQuery(
      { type: 'subagent_spawn', model: 'haiku', reason: 'Recovery lookup one' },
      { type: 'subagent_spawn', model: 'haiku', reason: 'Recovery lookup two' },
    );

    await expect(
      processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined),
    ).rejects.toBeInstanceOf(RetryableProviderStreamClosedError);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('[haiku ×2 — Recovery lookup one; +1 more]');
    expect(ackStatus()).toBe('processing');
  });
});

describe('provider heartbeat liveness', () => {
  it('stops heartbeat activity after a result while the provider stream remains open', async () => {
    const heartbeatPath = path.join(os.tmpdir(), `nanoclaw-provider-heartbeat-${Date.now()}.heartbeat`);
    fs.writeFileSync(heartbeatPath, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(heartbeatPath, old, old);
    const initialMtime = fs.statSync(heartbeatPath).mtimeMs;
    closeSessionDb();
    initTestSessionDb({ heartbeatPath });
    markClaimProcessing();

    const controlled = makeControlledQuery();
    controlled.events.emit({ type: 'init', continuation: 'sess-1' });
    const running = processQuery(
      controlled.query,
      ERR_ROUTING,
      ['m1'],
      'claude',
      '/tmp',
      undefined,
      'prompt',
      undefined,
      undefined,
      120_000,
      SUBAGENT_NOTICE_BATCH_MS,
    );

    try {
      await waitFor(() => fs.statSync(heartbeatPath).mtimeMs > initialMtime);
      controlled.events.emit({ type: 'result', text: '<internal>Provider completed.</internal>' });
      await waitFor(() => ackStatus('m1') === 'completed');
      const resultMtime = fs.statSync(heartbeatPath).mtimeMs;

      await Bun.sleep(25);
      expect(fs.statSync(heartbeatPath).mtimeMs).toBe(resultMtime);
    } finally {
      controlled.events.close();
      await running;
      fs.rmSync(heartbeatPath, { force: true });
    }
  });

  it('touches the heartbeat once when a follow-up exchange is accepted', async () => {
    const heartbeatPath = path.join(os.tmpdir(), `nanoclaw-followup-heartbeat-${Date.now()}.heartbeat`);
    fs.writeFileSync(heartbeatPath, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(heartbeatPath, old, old);
    const initialMtime = fs.statSync(heartbeatPath).mtimeMs;
    closeSessionDb();
    initTestSessionDb({ heartbeatPath });
    markClaimProcessing('m1');

    const controlled = makeControlledQuery();
    controlled.events.emit({ type: 'init', continuation: 'sess-1' });
    const running = processQuery(
      controlled.query,
      ERR_ROUTING,
      ['m1'],
      'claude',
      '/tmp',
      undefined,
      'initial prompt',
      undefined,
    );

    try {
      await waitFor(() => fs.statSync(heartbeatPath).mtimeMs > initialMtime);
      const initMtime = fs.statSync(heartbeatPath).mtimeMs;
      await Bun.sleep(5);

      insertMessage('m2', 'chat', { sender: 'Alice', text: 'follow-up' });
      await waitFor(() => controlled.pushes.length === 1);

      expect(ackStatus('m2')).toBe('processing');
      expect(fs.statSync(heartbeatPath).mtimeMs).toBeGreaterThan(initMtime);

      controlled.events.emit({ type: 'result', text: '<internal>Initial turn complete.</internal>' });
      controlled.events.emit({ type: 'result', text: '<internal>Follow-up complete.</internal>' });
      await waitFor(() => ackStatus('m2') === 'completed');
    } finally {
      controlled.events.close();
      await running.catch(() => {});
      fs.rmSync(heartbeatPath, { force: true });
    }
  });
});

describe('provider result acknowledgement and wrapping', () => {
  it('completes a coalesced follow-up with the active turn single result', async () => {
    markClaimProcessing('m1');
    const controlled = makeControlledQuery('coalesced');
    controlled.events.emit({ type: 'init', continuation: 'sess-1' });

    const running = processQuery(
      controlled.query,
      ERR_ROUTING,
      ['m1'],
      'codex',
      '/tmp',
      undefined,
      'initial prompt',
      undefined,
    );

    insertMessage('m2', 'chat', { sender: 'Alice', text: 'steered follow-up' });
    await waitFor(() => controlled.pushes.length === 1);
    expect(ackStatus('m2')).toBe('processing');

    controlled.events.emit({ type: 'result', text: '<internal>Combined turn done.</internal>' });
    await waitFor(() => ackStatus('m1') === 'completed' && ackStatus('m2') === 'completed');
    controlled.events.close();
    await running;
  });

  it('completes a Claude follow-up when the active turn emits one combined result', async () => {
    markClaimProcessing('m1');
    const controlled = makeControlledQuery('coalesced');
    controlled.events.emit({ type: 'init', continuation: 'sess-1' });

    const running = processQuery(
      controlled.query,
      ERR_ROUTING,
      ['m1'],
      'claude',
      '/tmp',
      undefined,
      'initial prompt',
      undefined,
    );

    insertMessage('m2', 'chat', { sender: 'Alice', text: 'follow-up while the visual is being prepared' });
    await waitFor(() => controlled.pushes.length === 1);

    controlled.events.emit({ type: 'result', text: '<internal>Combined response delivered.</internal>' });
    await waitFor(() => ackStatus('m1') === 'completed' && ackStatus('m2') === 'completed');
    controlled.events.close();
    await running;
  });

  it('keeps a pushed follow-up processing until its corresponding provider result', async () => {
    markClaimProcessing('m1');
    const controlled = makeControlledQuery();
    controlled.events.emit({ type: 'init', continuation: 'sess-1' });

    const running = processQuery(
      controlled.query,
      ERR_ROUTING,
      ['m1'],
      'claude',
      '/tmp',
      undefined,
      'initial prompt',
      undefined,
    );

    insertMessage('m2', 'chat', { sender: 'Alice', text: 'daily update' });
    await waitFor(() => controlled.pushes.length === 1);

    expect(ackStatus('m1')).toBe('processing');
    expect(ackStatus('m2')).toBe('processing');

    controlled.events.emit({ type: 'result', text: '<internal>Initial turn done.</internal>' });
    await waitFor(() => ackStatus('m1') === 'completed');
    expect(ackStatus('m2')).toBe('processing');

    controlled.events.emit({ type: 'result', text: '<internal>Daily update done.</internal>' });
    await waitFor(() => ackStatus('m2') === 'completed');
    controlled.events.close();
    await running;
  });

  it('does not push a scheduled task into an active interactive query', async () => {
    markClaimProcessing('m1');
    const controlled = makeControlledQuery();
    controlled.events.emit({ type: 'init', continuation: 'sess-1' });

    const running = processQuery(
      controlled.query,
      ERR_ROUTING,
      ['m1'],
      'claude',
      '/tmp',
      undefined,
      'initial prompt',
      undefined,
    );

    insertMessage('m2', 'task', { prompt: 'scheduled work' });
    await expect(running).rejects.toBeInstanceOf(RetryableProviderStreamClosedError);

    expect(controlled.pushes).toHaveLength(0);
    expect(getPendingMessages().map((m) => m.id)).toContain('m2');
  });

  it('aborts a retryable provider event that goes silent and leaves its exchange retryable', async () => {
    markClaimProcessing('m1');
    const controlled = makeControlledQuery();
    controlled.events.emit({ type: 'init', continuation: 'sess-1' });
    controlled.events.emit({ type: 'error', message: 'API retry', retryable: true });

    await expect(
      processQuery(
        controlled.query,
        ERR_ROUTING,
        ['m1'],
        'claude',
        '/tmp',
        undefined,
        'prompt',
        undefined,
        undefined,
        30,
      ),
    ).rejects.toBeInstanceOf(RetryableProviderStallError);

    expect(controlled.aborted()).toBe(true);
    expect(ackStatus('m1')).toBe('processing');
  }, 1_000);

  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    markClaimProcessing();
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(budgetText);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
    expect(ackStatus()).toBe('completed');
  });

  it('keeps a normal unwrapped result processing when the correction never arrives', async () => {
    markClaimProcessing();
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await expect(
      processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined),
    ).rejects.toBeInstanceOf(RetryableProviderStreamClosedError);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
    expect(ackStatus()).toBe('processing');
  });

  it('keeps an empty result completed after an MCP message already delivered the reply', async () => {
    markClaimProcessing();
    writeMessageOut({
      id: 'mcp-out',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'discord',
      thread_id: null,
      content: JSON.stringify({ text: 'Already sent through MCP.' }),
    });
    const { query, pushes } = makeResultQuery({ type: 'result', text: null });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(pushes).toHaveLength(0);
    expect(ackStatus()).toBe('completed');
  });

  it('completes an intentional internal-only result without a nudge', async () => {
    markClaimProcessing();
    const { query, pushes } = makeResultQuery({ type: 'result', text: '<internal>Nothing to send.</internal>' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(ackStatus()).toBe('completed');
  });

  it('leaves the original claim retryable when the one-shot wrapping correction also fails', async () => {
    markClaimProcessing();
    const { query, pushes } = makeEventQuery(
      { type: 'result', text: 'first bare response' },
      { type: 'result', text: 'still bare after the nudge' },
    );

    await expect(
      processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined),
    ).rejects.toBeInstanceOf(RetryableResponseFormatError);

    expect(pushes).toHaveLength(1);
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(ackStatus()).toBe('processing');
  });

  it('does not emit duplicate identical chat rows from one exchange', () => {
    const first = writeMessageOut({
      id: 'mcp-out',
      in_reply_to: 'm1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'discord',
      thread_id: null,
      content: JSON.stringify({ text: 'same response' }),
    });
    const duplicate = writeMessageOut({
      id: 'final-out',
      in_reply_to: 'm1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'discord',
      thread_id: null,
      content: JSON.stringify({ text: 'same response' }),
    });

    expect(duplicate).toBe(first);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('leaves the claim processing at compaction and completes it on the later real result', async () => {
    markClaimProcessing();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('primary', 'Primary', 'channel', 'discord', 'chan-1', NULL)`,
      )
      .run();

    let statusAfterCompaction = 'not-observed';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      yield { type: 'progress', message: 'Context compacted.' };
      statusAfterCompaction = ackStatus();
      yield { type: 'result', text: '<message to="primary">Final answer.</message>' };
    }
    const query: AgentQuery = {
      push: () => {},
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', '/tmp', undefined, 'prompt', undefined);

    expect(statusAfterCompaction).toBe('processing');
    expect(ackStatus()).toBe('completed');
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Final answer.');
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});
