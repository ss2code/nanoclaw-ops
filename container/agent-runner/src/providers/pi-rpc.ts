import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface PiRpcTransport {
  onStdout?: (chunk: string | Buffer) => void;
  onStderr?: (chunk: string | Buffer) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  write(line: string): void;
  kill(): void;
}

export type PiRpcMessage = Record<string, unknown>;

export class JsonlFrameDecoder {
  private buffered = '';

  push(chunk: string | Buffer): string[] {
    this.buffered += chunk.toString();
    const frames: string[] = [];
    for (;;) {
      const newline = this.buffered.indexOf('\n');
      if (newline < 0) break;
      let frame = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (frame.endsWith('\r')) frame = frame.slice(0, -1);
      if (frame.length > 0) frames.push(frame);
    }
    return frames;
  }
}

function redact(value: string): string {
  return value
    .replace(/((?:api[_-]?key|authorization|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|xai|or)-[A-Za-z0-9._-]{8,}\b/g, '[redacted]');
}

export class PiRpcClient {
  private readonly pending = new Map<
    string,
    { resolve: (value: PiRpcMessage) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Set<(event: PiRpcMessage) => void>();
  private readonly decoder = new JsonlFrameDecoder();
  private readonly requestTimeoutMs: number;
  private readonly stderrTailBytes: number;
  private stderrTail = '';
  private nextId = 1;
  private exited = false;

  constructor(private readonly transport: PiRpcTransport, options: { requestTimeoutMs?: number; stderrTailBytes?: number } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.stderrTailBytes = options.stderrTailBytes ?? 4_096;
    transport.onStdout = (chunk) => this.consumeStdout(chunk);
    transport.onStderr = (chunk) => {
      this.stderrTail = (this.stderrTail + redact(chunk.toString())).slice(-this.stderrTailBytes);
    };
    transport.onExit = (code, signal) => {
      this.exited = true;
      const suffix = this.stderrTail.trim() ? `; stderr: ${this.stderrTail.trim()}` : '';
      const error = new Error(`Pi RPC exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})${suffix}`);
      for (const item of this.pending.values()) {
        clearTimeout(item.timeout);
        item.reject(error);
      }
      this.pending.clear();
      this.emit({ type: 'rpc_exit', code, signal, message: error.message });
    };
  }

  onEvent(listener: (event: PiRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(command: PiRpcMessage): Promise<PiRpcMessage> {
    if (this.exited) return Promise.reject(new Error('Pi RPC process is not running'));
    const id = `nanoclaw-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC command timed out: ${String(command.type ?? 'unknown')}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.transport.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  close(): void {
    this.transport.kill();
  }

  private emit(event: PiRpcMessage): void {
    for (const listener of this.listeners) listener(event);
  }

  private consumeStdout(chunk: string | Buffer): void {
    for (const frame of this.decoder.push(chunk)) {
      let message: PiRpcMessage;
      try {
        message = JSON.parse(frame) as PiRpcMessage;
      } catch {
        this.emit({ type: 'rpc_protocol_error', message: 'Pi emitted invalid JSONL' });
        continue;
      }
      if (message.type === 'response' && typeof message.id === 'string') {
        const item = this.pending.get(message.id);
        if (item) {
          this.pending.delete(message.id);
          clearTimeout(item.timeout);
          if (message.success === false) {
            item.reject(new Error(`Pi RPC ${String(message.command ?? 'command')} failed: ${String(message.error ?? 'unknown error')}`));
          } else {
            item.resolve(message);
          }
          continue;
        }
      }
      this.emit(message);
    }
  }
}

export function spawnPiRpcTransport(args: string[], env: NodeJS.ProcessEnv = process.env, cwd?: string): PiRpcTransport {
  const child: ChildProcessWithoutNullStreams = spawn('pi', args, {
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
  });
  const transport: PiRpcTransport = {
    write(line) {
      child.stdin.write(line);
    },
    kill() {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    },
  };
  child.stdout.on('data', (chunk) => transport.onStdout?.(chunk));
  child.stderr.on('data', (chunk) => transport.onStderr?.(chunk));
  child.on('exit', (code, signal) => transport.onExit?.(code, signal));
  child.on('error', (error) => transport.onStderr?.(error.message));
  return transport;
}
