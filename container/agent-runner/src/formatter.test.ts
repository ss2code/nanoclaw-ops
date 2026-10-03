import { describe, expect, it } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { isClearCommand } from './formatter.js';

function message(text: string): MessageInRow {
  return { kind: 'chat', content: JSON.stringify({ text }) } as MessageInRow;
}

describe('isClearCommand', () => {
  it('recognizes a bare clear command and an addressed clear command', () => {
    expect(isClearCommand(message('/clear'))).toBe(true);
    expect(isClearCommand(message('@ganithaBot /clear'))).toBe(true);
    expect(isClearCommand(message('@ganithaBot /clear now'))).toBe(true);
  });

  it('does not treat longer command names as clear', () => {
    expect(isClearCommand(message('/clearance'))).toBe(false);
    expect(isClearCommand(message('@ganithaBot /clearance'))).toBe(false);
  });
});
