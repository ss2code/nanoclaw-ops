import fs from 'node:fs';
import path from 'node:path';

import { archiveProviderExchange } from './exchange-archive.js';
import { registerProvider } from './provider-registry.js';
import { PiRpcClient, spawnPiRpcTransport } from './pi-rpc.js';
import type {
  AgentProvider,
  AgentQuery,
  ModelTiers,
  ProviderEvent,
  ProviderExchange,
  ProviderOptions,
  QueryInput,
} from './types.js';

export interface PiRuntime {
  request(command: Record<string, unknown>): Promise<Record<string, any>>;
  eventStream(): AsyncGenerator<Record<string, unknown>>;
  close(): void;
}

const DEFAULT_SESSION_ROOT = '/workspace/pi-sessions';
const OBSERVABILITY_ROOT = '/workspace/pi-observability';
const EXTENSION_PATH = '/app/src/providers/pi-mcp-extension.ts';

function splitModel(full: string): { provider: string; modelId: string } {
  const slash = full.indexOf('/');
  if (slash <= 0 || slash === full.length - 1) throw new Error(`Pi model must be provider/model: ${full}`);
  return { provider: full.slice(0, slash).toLowerCase(), modelId: full.slice(slash + 1) };
}

export function resolvePiTurnModel(
  text: string,
  tiers: ModelTiers | undefined,
  configuredModel?: string,
): { provider: string; modelId: string; text: string } {
  const match = text.match(/\[tier:\s*(high|medium|low)\s*\]/i);
  const selected = tiers
    ? tiers[(match?.[1]?.toLowerCase() as keyof Pick<ModelTiers, 'high' | 'medium' | 'low'>) || tiers.default]
    : configuredModel;
  if (!selected) throw new Error('Pi provider requires a configured model or model tiers');
  return { ...splitModel(selected), text: match ? text.replace(match[0], '').trim() : text };
}

function normalizeThinking(effort?: string): string | undefined {
  if (!effort) return undefined;
  const value = effort.toLowerCase();
  if (value === 'none') return 'off';
  // NanoClaw's `max` is a fleet intent; xhigh is the highest portable level
  // across the current Grok/OpenRouter pilot catalog.
  if (value === 'max') return 'xhigh';
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
    throw new Error(`Unsupported Pi thinking level: ${effort}`);
  }
  return value;
}

function safeContinuation(value: string): string {
  const normalized = path.posix.normalize(value);
  if (!normalized.startsWith(`${piSessionRoot()}/`) || !normalized.endsWith('.jsonl')) {
    throw new Error('Invalid Pi continuation path');
  }
  return normalized;
}

function piSessionRoot(): string {
  return process.env.NANOCLAW_PI_SESSION_ROOT || DEFAULT_SESSION_ROOT;
}

function piTranscriptRotateBytes(): number {
  return Number(process.env.PI_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

function piTranscriptRotateAgeMs(): number {
  const raw = process.env.PI_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  return days > 0 ? days * 86_400_000 : Infinity;
}

function transcriptStartMs(file: string): number | null {
  try {
    const firstLine = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const timestamp = JSON.parse(firstLine)?.timestamp;
    const value = timestamp ? Date.parse(timestamp) : NaN;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function classifyError(message: string): string | undefined {
  if (/auth|api key|unauthorized|login|credential|oauth/i.test(message)) return 'auth';
  if (/quota|rate limit|billing|credit/i.test(message)) return 'quota';
  if (/session|conversation|jsonl|not found/i.test(message)) return 'stale-session';
  if (/mcp|required MCP server/i.test(message)) return 'mcp';
  return undefined;
}

function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/((?:authorization|api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|xai|or)-[A-Za-z0-9._-]{8,}\b/g, '[redacted]')
    .slice(0, 1_000);
}

function appendRuntimeEvent(type: string, fields: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(OBSERVABILITY_ROOT, { recursive: true });
    fs.appendFileSync(
      path.join(OBSERVABILITY_ROOT, 'events.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), provider: 'pi', type, ...fields })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Telemetry is diagnostic and must never take the assistant down.
  }
}

function defaultRuntimeFactory(options: ProviderOptions, cwd: string): Promise<PiRuntime> {
  const sessionRoot = piSessionRoot();
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.mkdirSync(OBSERVABILITY_ROOT, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    NANOCLAW_PI_MCP_CONFIG: JSON.stringify(options.mcpServers ?? {}),
    NANOCLAW_PI_OBSERVABILITY_DIR: OBSERVABILITY_ROOT,
  };
  const transport = spawnPiRpcTransport(
    ['--mode', 'rpc', '--approve', '--session-dir', sessionRoot, '--extension', EXTENSION_PATH],
    env,
    cwd,
  );
  const client = new PiRpcClient(transport, { requestTimeoutMs: 60_000 });
  const queue: Record<string, unknown>[] = [];
  let waiter: (() => void) | undefined;
  client.onEvent((event) => {
    queue.push(event);
    waiter?.();
    waiter = undefined;
  });
  appendRuntimeEvent('runtime_started', { cwd });
  return Promise.resolve({
    request: (command) => client.request(command),
    async *eventStream() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    },
    close() {
      client.close();
      appendRuntimeEvent('runtime_closed');
    },
  });
}

export class PiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly usesMemoryScaffold = true;
  private readonly options: ProviderOptions;
  private readonly runtimeFactory: (options: ProviderOptions, cwd: string) => Promise<PiRuntime>;

  constructor(options: ProviderOptions = {}, runtimeFactory = defaultRuntimeFactory) {
    this.options = options;
    this.runtimeFactory = runtimeFactory;
    normalizeThinking(options.effort);
  }

  onExchangeComplete(exchange: ProviderExchange): void {
    archiveProviderExchange({ provider: 'pi', ...exchange });
  }

  isSessionInvalid(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /invalid Pi continuation|session.*(?:not found|missing)|ENOENT.*\.jsonl/i.test(message);
  }

  maybeRotateContinuation(continuation: string): string | null {
    let transcriptPath: string;
    try {
      transcriptPath = safeContinuation(continuation);
    } catch {
      return null;
    }
    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }

    const startMs = transcriptStartMs(transcriptPath);
    const ageMs = startMs === null ? 0 : Date.now() - startMs;
    const maxBytes = piTranscriptRotateBytes();
    const maxAgeMs = piTranscriptRotateAgeMs();
    const reason =
      size > maxBytes
        ? `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`
        : startMs !== null && ageMs > maxAgeMs
          ? `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`
          : null;
    if (!reason) return null;

    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (error) {
      appendRuntimeEvent('session_rotation_failed', { message: String(error) });
      return null;
    }
    appendRuntimeEvent('session_rotated', { reason });
    return reason;
  }

  query(input: QueryInput): AgentQuery {
    let runtime: PiRuntime | undefined;
    let active = false;
    let aborted = false;
    let abortSent = false;
    const pendingSteers: string[] = [];

    const sendAbort = (): void => {
      if (!runtime || abortSent) return;
      abortSent = true;
      void runtime.request({ type: 'abort' }).catch(() => {});
    };

    const events = async function* (self: PiProvider): AsyncGenerator<ProviderEvent> {
      const started = Date.now();
      try {
        runtime = await self.runtimeFactory(self.options, input.cwd);
        if (input.continuation) {
          await runtime.request({ type: 'switch_session', sessionPath: safeContinuation(input.continuation) });
        }
        const selected = resolvePiTurnModel(input.prompt, self.options.modelTiers, self.options.model);
        await runtime.request({ type: 'set_model', provider: selected.provider, modelId: selected.modelId });
        const thinking = normalizeThinking(self.options.effort);
        if (thinking) await runtime.request({ type: 'set_thinking_level', level: thinking });
        const state = await runtime.request({ type: 'get_state' });
        const sessionFile = state.data?.sessionFile;
        if (typeof sessionFile !== 'string') throw new Error('Pi get_state returned no session file');
        const continuation = safeContinuation(sessionFile);
        yield { type: 'init', continuation };

        let message = selected.text;
        if (input.systemContext?.instructions) {
          message = `<system>\n${input.systemContext.instructions}\n</system>\n\n${message}`;
        }
        active = true;
        appendRuntimeEvent('turn_started', {
          provider: selected.provider,
          model: selected.modelId,
          resumed: Boolean(input.continuation),
        });
        await runtime.request({ type: 'prompt', message });
        for (const steer of pendingSteers.splice(0)) await runtime.request({ type: 'steer', message: steer });
        if (aborted) sendAbort();

        const iterator = runtime.eventStream();
        let pendingNext = iterator.next();
        for (;;) {
          // A synthetic pulse covers MCP servers that emit no progress while a
          // long external call is running; native Pi events still pulse too.
          const next = await Promise.race([
            pendingNext,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
          ]);
          if (next === null) {
            yield { type: 'activity' };
            continue;
          }
          if (next.done) throw new Error('Pi RPC event stream ended before agent_settled');
          pendingNext = iterator.next();
          yield { type: 'activity' };
          if (next.value.type === 'rpc_exit') throw new Error(String(next.value.message ?? 'Pi RPC exited'));
          if (next.value.type === 'extension_error') {
            appendRuntimeEvent('extension_error', {
              message: sanitizeDiagnostic(String(next.value.message ?? 'unknown')),
            });
          }
          if (next.value.type === 'agent_settled') break;
        }
        active = false;
        const last = await runtime.request({ type: 'get_last_assistant_text' });
        appendRuntimeEvent('turn_settled', { durationMs: Date.now() - started });
        yield { type: 'result', text: typeof last.data?.text === 'string' ? last.data.text : null };
      } catch (error) {
        const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
        appendRuntimeEvent('turn_error', {
          durationMs: Date.now() - started,
          classification: classifyError(message),
          message: message.slice(0, 500),
        });
        yield {
          type: 'error',
          message,
          retryable: !/auth|invalid Pi continuation|required MCP server/i.test(message),
          classification: classifyError(message),
        };
      } finally {
        active = false;
        runtime?.close();
      }
    };

    return {
      push: async (message): Promise<'coalesced'> => {
        if (runtime && active) await runtime.request({ type: 'steer', message });
        else pendingSteers.push(message);
        return 'coalesced';
      },
      end: () => {},
      abort: () => {
        aborted = true;
        sendAbort();
      },
      events: events(this),
    };
  }
}

registerProvider('pi', (options) => new PiProvider(options));
