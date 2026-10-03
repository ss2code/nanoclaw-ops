import { describe, expect, it } from 'bun:test';

import { JsonlFrameDecoder, PiRpcClient, type PiRpcTransport } from './pi-rpc.js';

class MemoryTransport implements PiRpcTransport {
  writes: string[] = [];
  onStdout?: (chunk: string | Buffer) => void;
  onStderr?: (chunk: string | Buffer) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;

  write(line: string): void {
    this.writes.push(line);
  }

  kill(): void {}

  respond(index: number, value: Record<string, unknown>): void {
    const command = JSON.parse(this.writes[index]);
    this.onStdout?.(`${JSON.stringify({ ...value, id: command.id })}\n`);
  }
}

describe('Pi JSONL RPC client', () => {
  it('frames only on LF and preserves Unicode line separators inside JSON strings', () => {
    const decoder = new JsonlFrameDecoder();
    expect(decoder.push('{"text":"a\u2028b"')).toEqual([]);
    expect(decoder.push('}\n{"type":"event"}\r\n')).toEqual(['{"text":"a\u2028b"}', '{"type":"event"}']);
  });

  it('correlates responses while streaming unrelated agent events', async () => {
    const transport = new MemoryTransport();
    const client = new PiRpcClient(transport, { requestTimeoutMs: 1_000 });
    const events: Record<string, unknown>[] = [];
    client.onEvent((event) => events.push(event));

    const pending = client.request({ type: 'get_state' });
    transport.onStdout?.('{"type":"tool_execution_start","toolName":"bash"}\n');
    transport.respond(0, { type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } });

    await expect(pending).resolves.toMatchObject({ success: true, data: { sessionId: 's1' } });
    expect(events).toEqual([{ type: 'tool_execution_start', toolName: 'bash' }]);
  });

  it('rejects pending requests with a bounded redacted stderr tail when Pi exits', async () => {
    const transport = new MemoryTransport();
    const client = new PiRpcClient(transport, { requestTimeoutMs: 1_000, stderrTailBytes: 80 });
    const pending = client.request({ type: 'get_state' });
    transport.onStderr?.(`OPENROUTER_API_KEY=secret-value\n${'x'.repeat(120)}`);
    transport.onExit?.(1, null);

    await expect(pending).rejects.toThrow(/Pi RPC exited/);
    await expect(pending).rejects.not.toThrow(/secret-value/);
  });
});
