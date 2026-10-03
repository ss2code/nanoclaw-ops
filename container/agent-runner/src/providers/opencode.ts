import { spawn, type ChildProcess } from 'child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/**
 * OpenRouter exposes reasoning effort per model, not per provider.  The
 * configured group-wide `max` intent must therefore be translated to the
 * highest value each registered model accepts; sending literal `max` to a
 * model that only accepts `high` would make the request invalid.
 *
 * Keep this deliberately narrow. Models absent from this verified capability
 * snapshot receive no override and retain their provider-native behavior.
 */
const OPENROUTER_REASONING_EFFORTS: Record<string, readonly string[]> = {
  'z-ai/glm-5.2': ['xhigh', 'high'],
  'openai/gpt-oss-120b': ['high', 'medium', 'low'],
};

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout|could not decrypt.*encrypted_content/i;

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function spawnOpencodeServer(config: Record<string, unknown>, timeoutMs = 10_000): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

/**
 * Deterministic per-turn model resolution. When tiers are configured the
 * returned model is ALWAYS set: the `[tier:high|medium|low]` directive's tier
 * when the turn carries one (directive stripped from the prompt), otherwise
 * the group's default tier. The caller must pass it explicitly on every
 * prompt — OpenCode otherwise falls back to whatever model the session was
 * created with (or its own small-model heuristics), silently ignoring the
 * configured default tier. No tiers → no pin (env-var model applies).
 */
export function resolveTurnModel(
  text: string,
  tiers: import('./types.js').ModelTiers | undefined,
  provider: string,
): { model?: { providerID: string; modelID: string }; text: string } {
  if (!tiers) return { text };
  const toModel = (full: string) => ({
    providerID: provider,
    modelID: full.replace(new RegExp(`^${provider}/`), ''),
  });
  const m = text.match(/\[tier:\s*(high|medium|low)\s*\]/i);
  if (!m) return { model: toModel(tiers[tiers.default]), text };
  const tier = m[1].toLowerCase() as 'high' | 'medium' | 'low';
  return {
    model: toModel(tiers[tier]),
    text: text.replace(m[0], '').trim(),
  };
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

function reasoningEffortForModel(provider: string, modelId: string, requestedEffort: string | undefined): string | undefined {
  if (provider !== 'openrouter' || !requestedEffort) return undefined;

  const supported = OPENROUTER_REASONING_EFFORTS[modelId];
  if (!supported) return undefined;

  // `max` is NanoClaw's fleet intent. OpenRouter model capabilities are not
  // uniform, so resolve it to each model's maximum supported value.
  if (requestedEffort === 'max') return supported[0];
  return supported.includes(requestedEffort) ? requestedEffort : undefined;
}

export function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = (process.env.OPENCODE_PROVIDER || 'anthropic').toLowerCase();
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;
  const providerBaseURL = provider === 'xai' ? undefined : proxyUrl;

  // Per-group high/medium/low tiers (container.json) take precedence over the
  // global OPENCODE_MODEL/OPENCODE_SMALL_MODEL env. When set: the main model is
  // the default tier, the small model is the low tier, all three are registered
  // with the provider, and each tier is exposed as a named subagent the agent
  // can delegate to. Without tiers we fall back to the env vars (unchanged
  // behavior for any other opencode group).
  const tiers = options.modelTiers;
  const model = tiers ? tiers[tiers.default] : process.env.OPENCODE_MODEL;
  const smallModel = tiers ? tiers.low : process.env.OPENCODE_SMALL_MODEL;

  const stripPrefix = (mid: string) => mid.replace(new RegExp(`^${provider}/`), '');
  const tierModelIds = tiers ? [tiers.high, tiers.medium, tiers.low] : [model, smallModel].filter(Boolean) as string[];
  const modelsToRegister = [...new Set(tierModelIds.map(stripPrefix))];

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: {
              apiKey: 'placeholder',
              ...(providerBaseURL ? { baseURL: providerBaseURL } : {}),
            },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => {
                      const reasoningEffort = reasoningEffortForModel(provider, mid, options.effort);
                      return [
                        mid,
                        {
                          id: mid,
                          name: mid,
                          tool_call: true,
                          ...(reasoningEffort ? { options: { reasoningEffort } } : {}),
                        },
                      ];
                    }),
                  ),
                }
              : {}),
          },
        };

  // Named tier subagents — the agent delegates via OpenCode's task tool to run
  // a subtask on a higher/lower model (agent-autonomous switching). Also lets an
  // errand from Jeeves that names a tier be honored per the routing instructions.
  const agent = tiers
    ? {
        high: { model: tiers.high, mode: 'subagent' as const, description: 'Strongest model — hard reasoning, complex multi-step or correctness-critical subtasks.' },
        medium: { model: tiers.medium, mode: 'subagent' as const, description: 'Balanced model — routine subtasks and multi-source work.' },
        low: { model: tiers.low, mode: 'subagent' as const, description: 'Cheapest model — quick lookups, fetch-and-summarize, reformatting.' },
      }
    : undefined;

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Load shared base + per-group fragments + per-group memory through OpenCode's
  // native instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  const instructions = [
    '/app/CLAUDE.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    ...(agent ? { agent } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    instructions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
    effort: options.effort,
    tiers: options.modelTiers ?? null,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let interruptTurn: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
      // Also unblock a turn parked in `await stream.next()`. Without this,
      // abort()/idle-timeout during an in-flight turn deadlock the generator:
      // the SSE next() never settles once the server is killed (and
      // stream.return() queues behind it), so the aborted/eventTimedOut
      // checks — which sit outside the await — are never reached and the
      // runner hangs until the host reaper kills the container.
      interruptTurn?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        // Pin this turn's model explicitly: the [tier:X] directive's tier when
        // present, else the group's default tier. Never rely on OpenCode's own
        // fallback — it reuses the session-creation model and ignores the
        // configured default.
        const tierProvider = process.env.OPENCODE_PROVIDER || 'anthropic';
        const { model: turnModel, text: promptText } = resolveTurnModel(text, self.options.modelTiers, tierProvider);
        if (turnModel) log(`turn model → ${turnModel.providerID}/${turnModel.modelID}`);

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text: promptText }], ...(turnModel ? { model: turnModel } : {}) },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            // Race the SSE read against kick() so abort()/idle-timeout can
            // cancel a parked turn (see kick() comment). On interrupt, loop
            // back to the aborted/eventTimedOut checks above.
            const raced = await Promise.race([
              stream.next(),
              new Promise<'interrupted'>((resolve) => {
                interruptTurn = () => resolve('interrupted');
              }),
            ]);
            interruptTurn = null;
            if (raced === 'interrupted') continue;

            const { value: ev, done } = raced;
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as { id?: string; role?: string } | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as { type?: string; messageID?: string; text?: string } | undefined;
                if (part?.type === 'text' && part.messageID && part.text) {
                  partTextByMessageId.set(part.messageID, part.text);
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
