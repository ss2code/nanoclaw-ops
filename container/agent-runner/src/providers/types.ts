export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /**
   * Optional. When true, the runner scaffolds a persistent `memory/` tree in the
   * agent's workspace at boot. Providers with their own native memory (e.g.
   * Claude's `CLAUDE.local.md`) omit this and get nothing — memory is opt-in per
   * provider, never gated on a provider name.
   */
  readonly usesMemoryScaffold?: boolean;

  /**
   * Optional. Providers with a native SessionStart context surface consume
   * the runner-owned persistent-memory hook through this capability seam.
   * The runner creates the scaffold and registers the descriptor at boot.
   */
  registerMemorySessionHook?(hook: MemorySessionHook): void;

  /**
   * Optional. Called by the poll-loop after each completed exchange (a
   * result, a wrapping retry, or an error). Providers whose harness keeps no
   * on-disk transcript implement this to persist exchanges themselves (e.g.
   * markdown into the agent's `conversations/` dir); providers that persist
   * and archive their own transcript (e.g. the Claude Agent SDK's `.jsonl`)
   * omit it. Best-effort: the loop catches and logs anything it throws. The
   * implementation lives with the provider, never in the runner.
   */
  onExchangeComplete?(exchange: ProviderExchange): void;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * Optional. Return true when this inbound text must start a NEW query
   * rather than be pushed into an already-running one — e.g. it carries a
   * per-turn model directive (`[tier:X]`) that only takes effect at query
   * creation (the Claude SDK fixes the model when the query starts).
   * Providers that apply such directives per pushed prompt (OpenCode) omit
   * this. The poll-loop winds down the active query and lets the batch
   * arrive as the initial prompt of a fresh query.
   */
  prefersFreshQuery?(text: string): boolean;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

export interface MemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/** One prompt/result round-trip, as reported to `onExchangeComplete`. */
export interface ProviderExchange {
  /** The user prompt this exchange answers (never an internal retry nudge). */
  prompt: string;
  result: string | null;
  /** Continuation/thread id in effect for the exchange, if any. */
  continuation?: string;
  status: 'completed' | 'undelivered' | 'error';
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
  /**
   * High/medium/low model routing (OpenCode/OpenRouter groups). When present,
   * the provider registers all three and derives its default model from the
   * named `default` tier. Providers that don't understand tiers ignore it.
   */
  modelTiers?: ModelTiers;
}

/** One of the three model-routing tiers. */
export type ModelTier = 'high' | 'medium' | 'low';

/** Per-group high/medium/low model routing. Each tier is a full model id. */
export interface ModelTiers {
  high: string;
  medium: string;
  low: string;
  default: ModelTier;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

export type McpServerConfig =
  | {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /** Absolute working directory for the MCP server process. */
      cwd?: string;
    }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface AgentQuery {
  /**
   * Push a follow-up message into the active query. Providers that steer the
   * input into the current in-flight turn return `coalesced`; providers that
   * will emit a distinct future result return `separate`. Legacy `void`
   * remains equivalent to `separate`.
   */
  push(message: string): PushDisposition | void | Promise<PushDisposition | void>;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type PushDisposition = 'separate' | 'coalesced';

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  /**
   * A completed turn. `isError` is set when the underlying SDK flagged the
   * turn as an error (e.g. a non-retryable Anthropic 403 billing_error). The
   * poll-loop uses it to surface the result text to the user instead of
   * dropping it as un-wrapped scratchpad, and to skip the re-wrap nudge.
   */
  | { type: 'result'; text: string | null; isError?: boolean }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /** A harness-generated file that the runner must deliver to the reply destination. */
  | { type: 'file'; path: string }
  | {
      type: 'subagent_spawn';
      model: string;
      reason: string;
      /** Tier switches stay immediate; ordinary subagent fan-out is batched. */
      noticeMode?: 'batched' | 'immediate';
    }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
