import { describe, expect, it } from 'bun:test';

import { PiProvider, resolvePiTurnModel, type PiRuntime } from './pi.js';

class FakeRuntime implements PiRuntime {
  commands: Array<Record<string, unknown>> = [];
  private events: Array<Record<string, unknown>> = [];

  queue(...events: Array<Record<string, unknown>>): void {
    this.events.push(...events);
  }

  async request(command: Record<string, unknown>): Promise<any> {
    this.commands.push(command);
    switch (command.type) {
      case 'get_state':
        return { success: true, data: { sessionFile: '/workspace/pi-sessions/s1.jsonl', sessionId: 's1' } };
      case 'get_last_assistant_text':
        return { success: true, data: { text: '<message>done</message>' } };
      default:
        return { success: true, data: { cancelled: false } };
    }
  }

  async *eventStream(): AsyncGenerator<Record<string, unknown>> {
    while (this.events.length > 0) yield this.events.shift()!;
  }

  close(): void {}
}

describe('Pi provider', () => {
  it('resolves default and explicit model tiers while stripping the directive', () => {
    const tiers = {
      high: 'xai/grok-4.6',
      medium: 'xai/grok-4.5',
      low: 'xai/grok-4.3',
      default: 'medium' as const,
    };
    expect(resolvePiTurnModel('hello', tiers)).toEqual({ provider: 'xai', modelId: 'grok-4.5', text: 'hello' });
    expect(resolvePiTurnModel('[tier:high] solve', tiers)).toEqual({
      provider: 'xai',
      modelId: 'grok-4.6',
      text: 'solve',
    });
  });

  it('sets model and thinking, emits the Pi session file as continuation, and settles on the final assistant text', async () => {
    const runtime = new FakeRuntime();
    runtime.queue(
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolName: 'mcp__gmail__search_emails' },
      { type: 'agent_settled' },
    );
    const provider = new PiProvider(
      {
        effort: 'max',
        modelTiers: {
          high: 'openrouter/z-ai/glm-5.3-flash',
          medium: 'openrouter/deepseek/deepseek-v4',
          low: 'openrouter/z-ai/glm-5.2:free',
          default: 'medium',
        },
      },
      async () => runtime,
    );

    const query = provider.query({ prompt: '[tier:high] investigate', cwd: '/workspace/agent' });
    const events = [];
    for await (const event of query.events) events.push(event);

    expect(runtime.commands.map((command) => command.type)).toEqual([
      'set_model',
      'set_thinking_level',
      'get_state',
      'prompt',
      'get_last_assistant_text',
    ]);
    expect(runtime.commands[0]).toMatchObject({ provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' });
    expect(runtime.commands[1]).toMatchObject({ level: 'xhigh' });
    expect(runtime.commands[3]).toMatchObject({ message: 'investigate' });
    expect(events).toContainEqual({ type: 'init', continuation: '/workspace/pi-sessions/s1.jsonl' });
    expect(events).toContainEqual({ type: 'activity' });
    expect(events.at(-1)).toEqual({ type: 'result', text: '<message>done</message>' });
  });

  it('resumes an opaque session, steers follow-ups as coalesced input, and aborts without replay', async () => {
    const runtime = new FakeRuntime();
    runtime.queue({ type: 'agent_settled' });
    const provider = new PiProvider({ model: 'xai/grok-4.6' }, async () => runtime);
    const query = provider.query({
      prompt: 'continue',
      continuation: '/workspace/pi-sessions/old.jsonl',
      cwd: '/workspace/agent',
    });

    expect(await query.push('new direction')).toBe('coalesced');
    query.abort();
    for await (const _event of query.events) {
      // Drain startup/settlement.
    }

    expect(runtime.commands.some((command) => command.type === 'switch_session')).toBe(true);
    expect(runtime.commands.some((command) => command.type === 'steer')).toBe(true);
    expect(runtime.commands.filter((command) => command.type === 'abort')).toHaveLength(1);
  });
});
