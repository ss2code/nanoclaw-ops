import { describe, expect, it, vi } from 'vitest';

import { buildCliRoutedMessage, writeCliDelivery } from './cli.js';

describe('buildCliRoutedMessage', () => {
  it('marks an explicitly addressed routed message as a mention', () => {
    const message = buildCliRoutedMessage({
      text: '@ganithaBot report the student',
      sender: 'cli',
      senderName: 'Operator',
      senderId: 'telegram:8829174721',
    });

    expect(message.isMention).toBe(true);
    expect(JSON.parse(message.content)).toMatchObject({
      text: '@ganithaBot report the student',
      sender: 'cli',
      senderName: 'Operator',
      senderId: 'telegram:8829174721',
    });
  });

  it('does not mark an unaddressed routed message as a mention', () => {
    expect(buildCliRoutedMessage({ text: 'background note' }).isMention).toBe(false);
  });
});

describe('writeCliDelivery', () => {
  const message = { kind: 'chat', content: { text: 'hello from the agent' } };

  it('writes a response and returns a receipt', () => {
    const write = vi.fn(() => true);
    const receipt = writeCliDelivery({ write }, 'local', message);

    expect(write).toHaveBeenCalledWith('{"text":"hello from the agent"}\n');
    expect(receipt).toMatch(/^cli-/);
  });

  it.each([
    ['disconnected client', null, 'CLI client is not connected'],
    ['wrong platform', { write: vi.fn() }, 'CLI adapter cannot deliver to platform telegram:123'],
  ])('throws for %s', (_name, client, error) => {
    expect(() => writeCliDelivery(client, _name === 'wrong platform' ? 'telegram:123' : 'local', message)).toThrow(
      error,
    );
  });

  it('throws when the socket write fails', () => {
    const write = vi.fn(() => {
      throw new Error('socket closed');
    });

    expect(() => writeCliDelivery({ write }, 'local', message)).toThrow('socket closed');
  });

  it('throws when the message has no text', () => {
    expect(() => writeCliDelivery({ write: vi.fn() }, 'local', { kind: 'chat', content: {} })).toThrow(
      'CLI message has no displayable text',
    );
  });
});
