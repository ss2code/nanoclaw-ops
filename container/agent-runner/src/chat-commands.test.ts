import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  discoverEnabledSkills,
  extractChatText,
  handleChatCommand,
  hasAgentAddress,
  replaceChatText,
  type ChatCommandContext,
} from './chat-commands.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';

let dir: string;
const consultScript = path.resolve(process.cwd(), 'container/skills/consult/scripts/consult.mjs');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-chat-commands-'));
  process.env.NANOCLAW_CONSULT_SKILL_SCRIPT = consultScript;
  process.env.NANOCLAW_CONSULT_STATE_DIR = path.join(dir, 'consultations');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.NANOCLAW_CONSULT_SKILL_SCRIPT;
  delete process.env.NANOCLAW_CONSULT_STATE_DIR;
});

function ctx(overrides: Partial<ChatCommandContext> = {}): ChatCommandContext {
  return {
    assistantName: 'Jeeves',
    providerName: 'claude',
    configuredModel: 'sonnet',
    modelTiers: undefined,
    hasContinuation: true,
    enabledSkills: [
      { name: 'memory', description: 'Memory capability.', userInvocable: false },
      { name: 'consult', description: 'Multi-model consultations.', userInvocable: true },
      { name: 'memory-audit', description: 'Audit memory health.', userInvocable: true },
      { name: 'memory-review', description: 'Review memory proposals.', userInvocable: true },
    ],
    destinations: [
      { name: 'research', displayName: 'Research Agent', type: 'agent', agentGroupId: 'ag-research' },
      { name: 'family', displayName: 'Family Chat', type: 'channel', channelType: 'whatsapp', platformId: 'g1' },
    ],
    ...overrides,
  };
}

describe('enabled skill discovery', () => {
  it('lists only mounted roots and distinguishes invocable SKILL.md from instruction-only capabilities', () => {
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'instructions.md'), '# memory');
    fs.mkdirSync(path.join(dir, 'memory-review'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'memory-review', 'SKILL.md'),
      '---\nname: memory-review\ndescription: Propose memory changes.\n---\n',
    );

    expect(discoverEnabledSkills(dir)).toEqual([
      { name: 'memory', description: 'Enabled container capability.', userInvocable: false },
      { name: 'memory-review', description: 'Propose memory changes.', userInvocable: true },
    ]);
  });
});

describe('command palette', () => {
  it('rewrites friendly model aliases into the existing deterministic tier directive', () => {
    expect(handleChatCommand('/model hi diagnose this', ctx())).toEqual({
      action: 'rewrite',
      text: 'diagnose this\n\n[tier:high]',
    });
    expect(handleChatCommand('/model mid summarize this', ctx())).toEqual({
      action: 'rewrite',
      text: 'summarize this\n\n[tier:medium]',
    });
  });

  it('tolerates trailing punctuation on the tier token (regression: 2026-07-14 routing outage)', () => {
    // "/model low." / "/model mid," used to fail alias lookup → "Unknown model
    // tier" → the task never reached a model at all.
    expect(handleChatCommand('/model low. lookup this', ctx())).toEqual({
      action: 'rewrite',
      text: 'lookup this\n\n[tier:low]',
    });
    expect(handleChatCommand('/model mid, summarize this', ctx())).toEqual({
      action: 'rewrite',
      text: 'summarize this\n\n[tier:medium]',
    });
    expect(handleChatCommand('/model default. what is your model?', ctx())).toEqual({
      action: 'rewrite',
      text: 'what is your model?',
    });
    // Genuinely unknown tiers must still be rejected, not silently passed on.
    const unknown = handleChatCommand('/model turbo do this', ctx());
    expect(unknown.action).toBe('respond');
    if (unknown.action === 'respond') expect(unknown.text).toContain('Unknown model tier');
  });

  it('composes model selection with a direct enabled skill invocation', () => {
    const result = handleChatCommand('/model low /memory-audit health', ctx());
    expect(result.action).toBe('rewrite');
    if (result.action === 'rewrite') {
      expect(result.text).toContain('Invoke the enabled `memory-audit` skill');
      expect(result.text).toContain('User arguments: health');
      expect(result.text).toContain('[tier:low]');
    }
  });

  it('supports /skill and /run forms but refuses skills not enabled in this container', () => {
    expect(handleChatCommand('/skill memory-review --since 48h', ctx()).action).toBe('rewrite');
    expect(handleChatCommand('/run memory-audit eval', ctx()).action).toBe('rewrite');
    const unavailable = handleChatCommand('/skill finance brief', ctx());
    expect(unavailable.action).toBe('respond');
    if (unavailable.action === 'respond') expect(unavailable.text).toContain('not enabled');
  });

  it('requires the dedicated /consult command surface instead of generic skill dispatch', () => {
    for (const text of ['/skill consult quick Should we ship?', '/run consult quick Should we ship?']) {
      const result = handleChatCommand(text, ctx());
      expect(result.action).toBe('respond');
      if (result.action === 'respond') expect(result.text).toContain('Use /consult');
    }
    // Natural-language mentions are not a skill trigger; they remain ordinary
    // conversation for the current agent.
    expect(handleChatCommand('Please consult another model', ctx()).action).toBe('pass');
  });

  it('shows only enabled user-invocable skills in /skills and /cmd-help', () => {
    const skills = handleChatCommand('/skills', ctx());
    expect(skills.action).toBe('respond');
    if (skills.action === 'respond') {
      expect(skills.text).toContain('/memory-review');
      expect(skills.text).toContain('/memory-audit');
      expect(skills.text).not.toContain('/finance');
      expect(skills.text).toContain('/skill <skill-name>');
      expect(skills.text).toContain('/run <skill-name>');
    }

    const help = handleChatCommand('/cmd-help', ctx());
    expect(help.action).toBe('respond');
    if (help.action === 'respond') {
      expect(help.text).toContain('/memory-review');
      expect(help.text).toContain('/recall');
      expect(help.text).toContain('/tasks');
      expect(help.text).toContain('/consult help');
      expect(help.text).toContain('/consult ask');
      expect(help.text).toContain('/consult more');
      expect(help.text).not.toContain('/finance');
    }
  });

  it('rewrites recall and remember only when memory is enabled', () => {
    expect(handleChatCommand('/recall aisle seat preferences', ctx()).action).toBe('rewrite');
    expect(handleChatCommand('/remember Alice prefers aisle seats', ctx()).action).toBe('rewrite');

    const disabled = ctx({ enabledSkills: [] });
    const result = handleChatCommand('/recall aisle seats', disabled);
    expect(result.action).toBe('respond');
    if (result.action === 'respond') expect(result.text).toContain('not enabled');
  });

  it('provides task options and rewrites task actions to canonical fleet commands', () => {
    const options = handleChatCommand('/tasks', ctx());
    expect(options.action).toBe('respond');
    if (options.action === 'respond') expect(options.text).toContain('/tasks add');

    const add = handleChatCommand('/tasks add Renew passport | due 2026-08-01', ctx());
    expect(add.action).toBe('rewrite');
    if (add.action === 'rewrite') expect(add.text).toContain('/task_add Renew passport | due 2026-08-01');
  });

  it('delegates only to ACL-backed agent destinations and leaves platform mentions alone', () => {
    const delegated = handleChatCommand('@research /model hi investigate this', ctx());
    expect(delegated).toEqual({
      action: 'delegate',
      destination: { name: 'research', displayName: 'Research Agent', type: 'agent', agentGroupId: 'ag-research' },
      text: '/model hi investigate this',
      acknowledgement: 'Delegated to @research. Its result will return to this conversation.',
    });
    expect(hasAgentAddress('@research do this', ctx().destinations)).toBe(true);
    expect(hasAgentAddress('@family hello', ctx().destinations)).toBe(false);
    expect(handleChatCommand('@botname hello', ctx()).action).toBe('pass');
  });

  it('reports model/status/agent information without a model turn', () => {
    const status = handleChatCommand('/status', ctx());
    expect(status.action).toBe('respond');
    if (status.action === 'respond') {
      expect(status.text).toContain('Provider: claude');
      expect(status.text).toContain('high=opus');
      expect(status.text).toContain('@research');
    }

    const agents = handleChatCommand('/agents', ctx());
    expect(agents.action).toBe('respond');
    if (agents.action === 'respond') {
      expect(agents.text).toContain('@research');
      expect(agents.text).not.toContain('@family');
    }
  });

  it('preserves native slash commands for the existing provider command path', () => {
    expect(handleChatCommand('/compact', ctx())).toEqual({ action: 'pass' });
    expect(handleChatCommand('/upload-trace', ctx())).toEqual({ action: 'pass' });
  });
});

describe('message content helpers', () => {
  it('preserves channel metadata when rewriting JSON content', () => {
    const original = JSON.stringify({ text: '/model hi test', sender: 'Alice', attachments: [{ name: 'a.txt' }] });
    const rewritten = replaceChatText(original, 'test [tier:high]');
    expect(extractChatText(rewritten)).toBe('test [tier:high]');
    expect(JSON.parse(rewritten).sender).toBe('Alice');
    expect(JSON.parse(rewritten).attachments).toEqual([{ name: 'a.txt' }]);
  });
});

describe('poll-loop integration', () => {
  beforeEach(() => {
    initTestSessionDb({ heartbeatPath: path.join(dir, '.heartbeat') });
  });

  afterEach(() => {
    closeSessionDb();
  });

  it('intercepts an ACL-backed @agent command, delegates it, acknowledges the channel, and skips the provider', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('research', 'Research Agent', 'agent', NULL, NULL, 'ag-research')`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-delegate', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '@research /model hi investigate this' }));

    let queried = false;
    const provider = new MockProvider({}, () => {
      queried = true;
      return '<message to="research">provider should not run</message>';
    });
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerName: 'claude',
      cwd: '/tmp',
      assistantName: 'Jeeves',
      skillsDir: dir,
      signal: controller.signal,
    });

    await waitFor(() => getUndeliveredMessages().length === 2, 3000);
    controller.abort();
    await loop;

    const out = getUndeliveredMessages();
    expect(queried).toBe(false);
    expect(out.find((row) => row.channel_type === 'agent')?.platform_id).toBe('ag-research');
    expect(JSON.parse(out.find((row) => row.channel_type === 'agent')!.content).text).toBe(
      '/model hi investigate this',
    );
    expect(JSON.parse(out.find((row) => row.channel_type === 'discord')!.content).text).toContain(
      'Delegated to @research',
    );
    expect(getPendingMessages()).toHaveLength(0);
  });

  it('touches the heartbeat for /cmd-help finance even though the provider is skipped', async () => {
    fs.mkdirSync(path.join(dir, 'finance'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'finance', 'SKILL.md'),
      '---\nname: finance\ndescription: Finance workflows.\n---\n',
    );
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-command-help', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/cmd-help finance' }));

    let queried = false;
    const provider = new MockProvider({}, () => {
      queried = true;
      return 'provider should not run';
    });
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerName: 'claude',
      cwd: '/tmp',
      assistantName: 'Jeeves',
      skillsDir: dir,
      signal: controller.signal,
    });

    await waitFor(() => getUndeliveredMessages().length === 1, 3000);
    controller.abort();
    await loop;

    const out = getUndeliveredMessages();
    expect(queried).toBe(false);
    expect(JSON.parse(out[0].content).text).toContain('/finance');
    expect(getPendingMessages()).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, '.heartbeat'))).toBe(true);
  });

  it('runs /consult roster locally, emits probe envelopes, and never invokes the provider', async () => {
    for (const [name, group] of [['atlas', 'ag-atlas'], ['errand-runner', 'ag-errand']]) {
      getInboundDb()
        .prepare(
          `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
           VALUES (?, ?, 'agent', NULL, NULL, ?)`,
        )
        .run(name, name, group);
    }
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-consult-roster', 'chat', datetime('now'), 'pending', 'chan-1', 'whatsapp', ?)`,
      )
      .run(JSON.stringify({ text: '/consult roster --refresh' }));

    let queried = false;
    const provider = new MockProvider({}, () => {
      queried = true;
      return '<message to="atlas">provider should not run</message>';
    });
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerName: 'codex',
      configuredModel: 'gpt-5.6-luna',
      effort: 'xhigh',
      agentGroupId: 'jeeves',
      cwd: '/tmp',
      assistantName: 'Jeeves',
      skillsDir: dir,
      signal: controller.signal,
    });

    await waitFor(() => getUndeliveredMessages().length === 3, 3000);
    controller.abort();
    await loop;

    expect(queried).toBe(false);
    const out = getUndeliveredMessages();
    const probes = out.filter((row) => row.channel_type === 'agent').map((row) => JSON.parse(row.content));
    expect(probes).toHaveLength(2);
    expect(probes.every((content) => content.consult.kind === 'roster-probe')).toBe(true);
    expect(JSON.parse(out.find((row) => row.channel_type === 'whatsapp')!.content).text).toContain('No LLM calls');
  });
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
