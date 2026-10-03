import { findByName, findByRouting, getAllDestinations, type DestinationEntry } from './destinations.js';
import { applyChatCommands, type ChatCommandRuntimeContext } from './chat-command-runtime.js';
import { applyConsultCommands } from './consult-command-runtime.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import { clearCurrentInReplyTo, clearCurrentTurnId, setCurrentInReplyTo, setCurrentTurnId } from './current-batch.js';
import { clearCurrentConsultationCapture, setCurrentConsultationCapture } from './consult-correlation.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import { enqueueFileOut } from './outbox.js';
import { emitWorkflowEvent } from './workflow-events.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';
import {
  buildGrounding,
  finalizeGrounding,
  prependGrounding,
  recordGrounding,
} from './trip-grounding.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
/**
 * The Claude SDK normally recovers from api_retry events itself. If it emits
 * no further event for this long, treat the exchange as stalled so the host's
 * durable retry path can take ownership instead of waiting for the 30-minute
 * container ceiling.
 */
export const PROVIDER_RETRY_STALL_MS = 2 * 60 * 1000;
/**
 * Fan-out tools arrive as a short burst of provider events. Holding chat
 * notices until the burst goes quiet preserves model transparency without
 * turning a many-worker task into one user notification per worker.
 */
export const SUBAGENT_NOTICE_BATCH_MS = 5_000;

export class RetryableQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableQueryError';
  }
}

export class RetryableProviderStallError extends RetryableQueryError {
  constructor(timeoutMs: number) {
    super(`Provider retry produced no activity for ${Math.ceil(timeoutMs / 1000)} seconds`);
    this.name = 'RetryableProviderStallError';
  }
}

export class RetryableProviderStreamClosedError extends RetryableQueryError {
  constructor(pendingCount: number) {
    super(`Provider stream closed with ${pendingCount} unfinished exchange(s)`);
    this.name = 'RetryableProviderStreamClosedError';
  }
}

/**
 * The provider ignored the one-shot delivery-envelope correction. Keep the
 * inbound exchange retryable so the host can recover it, but do not describe a
 * formatting failure as a provider transport stall to the user.
 */
export class RetryableResponseFormatError extends RetryableQueryError {
  constructor() {
    super('Provider returned an unwrapped response after the delivery correction');
    this.name = 'RetryableResponseFormatError';
  }
}

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

export function hasWakeTrigger(messages: Array<Pick<MessageInRow, 'trigger'>>): boolean {
  return messages.some((m) => m.trigger === 1);
}

/**
 * Host-generated control rows use the agent channel but target the current
 * agent group. They must be acknowledged without entering the provider prompt
 * queue, otherwise a provider error can become a self-addressed error loop.
 */
export function isSelfAddressedMessage(
  message: Pick<MessageInRow, 'kind' | 'channel_type' | 'platform_id'>,
  agentGroupId?: string,
): boolean {
  return Boolean(
    agentGroupId &&
      message.kind !== 'system' &&
      message.channel_type === 'agent' &&
      message.platform_id === agentGroupId,
  );
}

/** Scheduled work starts a clean provider continuation instead of inheriting chat history. */
export function hasScheduledTask(messages: Array<Pick<MessageInRow, 'kind'>>): boolean {
  return messages.some((m) => m.kind === 'task');
}

export type ScheduledDelegation = 'errand-runner';

/**
 * Return the explicit execution plane for a scheduled task. Prose in a task
 * prompt is intentionally not treated as a routing signal: an explicit field
 * is what makes scheduled handoff deterministic and safe across future skills.
 */
export function getScheduledDelegation(message: Pick<MessageInRow, 'kind' | 'content'>): ScheduledDelegation | null {
  if (message.kind !== 'task') return null;
  try {
    const content = JSON.parse(message.content) as { delegateTo?: unknown };
    return content.delegateTo === 'errand-runner' ? 'errand-runner' : null;
  } catch {
    return null;
  }
}

/** Build a self-contained, non-sensitive request for the Errand Runner. */
export function buildScheduledDelegationPrompt(
  message: Pick<MessageInRow, 'id' | 'content' | 'channel_type' | 'platform_id'>,
): string {
  let content: { prompt?: unknown; scriptOutput?: unknown };
  try {
    content = JSON.parse(message.content) as { prompt?: unknown; scriptOutput?: unknown };
  } catch {
    content = { prompt: message.content };
  }

  const taskPrompt = typeof content.prompt === 'string' ? content.prompt : '';
  const explicitTier = taskPrompt.match(/\[tier:\s*(high|medium|low)\s*\]/i);
  const cleanTaskPrompt = taskPrompt.replace(/\[tier:\s*(high|medium|low)\s*\]/gi, '').trim();
  const destinationName = findByRouting(message.channel_type, message.platform_id)?.name;
  const lines = [
    `[scheduled-task id=${message.id}]`,
    ...(explicitTier ? [`[tier:${explicitTier[1].toLowerCase()}]`] : []),
    'Perform only the stateless public/research portion of this scheduled task.',
    'Do not request or use Jeeves credentials, private memory, or authenticated services.',
    'Jeeves owns final synthesis and delivery, including document-hub publication.',
    `Original final delivery target: ${destinationName ?? 'the original scheduled destination'}; Jeeves must preserve that destination when it replies.`,
    'Return the verified result to Jeeves; do not send it to a channel directly.',
    '',
    'Instructions:',
    cleanTaskPrompt,
  ];
  if (content.scriptOutput !== undefined) {
    lines.push('', 'Deterministic pre-task scriptOutput:', JSON.stringify(content.scriptOutput, null, 2));
  }
  return lines.join('\n');
}

function handoffScheduledTask(message: MessageInRow): boolean {
  const target = findByName('errand-runner');
  if (!target?.agentGroupId) {
    log(
      `Scheduled task ${message.id} requested Errand Runner, but the destination is not configured; keeping it in Jeeves`,
    );
    return false;
  }

  writeMessageOut({
    id: generateId(),
    in_reply_to: message.id,
    kind: 'chat',
    platform_id: target.agentGroupId,
    channel_type: 'agent',
    thread_id: null,
    content: JSON.stringify({ text: buildScheduledDelegationPrompt(message) }),
  });
  log(`Scheduled task ${message.id} handed off to Errand Runner (${target.agentGroupId})`);
  return true;
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type SubagentSpawnEvent = Extract<ProviderEvent, { type: 'subagent_spawn' }>;

function summarizeSubagentSpawns(spawns: SubagentSpawnEvent[]): string {
  if (spawns.length === 1) {
    const [spawn] = spawns;
    return `[${spawn.model} — ${spawn.reason}]`;
  }

  const modelCounts = new Map<string, number>();
  for (const spawn of spawns) {
    modelCounts.set(spawn.model, (modelCounts.get(spawn.model) ?? 0) + 1);
  }

  if (modelCounts.size === 1) {
    const [model] = modelCounts.keys();
    return `[${model} ×${spawns.length} — ${spawns[0].reason}; +${spawns.length - 1} more]`;
  }

  const counts = [...modelCounts.entries()].map(([model, count]) => `${model} ×${count}`).join(', ');
  return `[${spawns.length} subagents — ${counts}]`;
}

class SubagentNoticeBatcher {
  private pending: SubagentSpawnEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly quietMs: number,
  ) {}

  add(event: SubagentSpawnEvent): void {
    if (event.noticeMode === 'immediate') {
      this.flush();
      this.emitSafely(summarizeSubagentSpawns([event]));
      return;
    }

    this.pending.push(event);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.quietMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const pending = this.pending;
    this.pending = [];
    this.emitSafely(summarizeSubagentSpawns(pending));
  }

  private emitSafely(text: string): void {
    try {
      this.emit(text);
    } catch (err) {
      log(`Failed to write subagent notice: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  /** Runtime metadata used by the provider-neutral chat command palette. */
  assistantName?: string;
  configuredModel?: string;
  effort?: string;
  modelTiers?: import('./providers/types.js').ModelTiers;
  /** Agent group id used to reject host/control rows addressed back to self. */
  agentGroupId?: string;
  skillsDir?: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    if (config.signal?.aborted) return;
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question).
    // A host restart/error notice is represented as an agent message addressed
    // to this group. It is a control record, not a new user turn; feeding it to
    // the provider can make the agent emit the same error back to itself.
    const pending = getPendingMessages(isFirstPoll);
    const selfAddressed = pending.filter((m) => isSelfAddressedMessage(m, config.agentGroupId));
    if (selfAddressed.length > 0) {
      markCompleted(selfAddressed.map((m) => m.id));
      log(`Discarded ${selfAddressed.length} self-addressed agent control message(s)`);
    }
    const messages = pending.filter((m) => m.kind !== 'system' && !isSelfAddressedMessage(m, config.agentGroupId));
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!hasWakeTrigger(messages)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Scheduled work is deliberately isolated from the interactive transcript.
    // Clear the opaque provider continuation directly rather than injecting a
    // visible `/clear` message, which would consume a turn and still rely on
    // the model to interpret the command correctly.
    if (hasScheduledTask(messages) && continuation) {
      log('Scheduled task batch — resetting continuation before processing');
      continuation = undefined;
      clearContinuation(config.providerName);
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);
    // Establish activity before branching into deterministic command handling.
    // Commands such as /cmd-help can complete without creating a provider
    // query, so provider-event heartbeats alone leave no idle-reap anchor.
    touchHeartbeat();

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The runner handles its
    // deterministic built-ins plus the fleet-wide chat command palette.
    const commandCandidates: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: uploadTrace() }),
        });
        commandIds.push(msg.id);
        continue;
      }
      commandCandidates.push(msg);
    }

    const palette = applyChatCommands(commandCandidates, {
      assistantName: config.assistantName,
      providerName: config.providerName,
      configuredModel: config.configuredModel,
      effort: config.effort,
      modelTiers: config.modelTiers,
      agentGroupId: config.agentGroupId,
      skillsDir: config.skillsDir,
      hasContinuation: continuation !== undefined,
    });
    const normalMessages = palette.messages;
    commandIds.push(...palette.handledIds);

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    let delegatedIds: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    // An explicit schedule execution plane is a deterministic runtime route,
    // not a suggestion to the provider. Handoff happens after the optional
    // script so the worker receives verified script output, and before any
    // provider query so Jeeves does not spend a turn duplicating the work.
    const delegated: MessageInRow[] = [];
    const local: MessageInRow[] = [];
    for (const msg of keep) {
      if (getScheduledDelegation(msg) === 'errand-runner' && handoffScheduledTask(msg)) {
        delegated.push(msg);
      } else {
        local.push(msg);
      }
    }
    if (delegated.length > 0) {
      delegatedIds = delegated.map((msg) => msg.id);
      markCompleted(delegatedIds);
      log(`Handed off ${delegated.length} scheduled task(s) before provider query`);
    }
    keep = local;

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) were handled before provider query, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const grounding = buildGrounding(config.cwd, keep);
    const groundingEventId = recordGrounding(
      keep.map((message) => message.id),
      grounding,
    );
    const prompt = prependGrounding(
      formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands),
      grounding,
    );

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const delegatedSet = new Set(delegatedIds);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id) && !delegatedSet.has(id));
    // Publish the batch identity so outbound tools and workflow receipts can
    // correlate with the same generic NanoClaw turn.
    setCurrentInReplyTo(routing.inReplyTo);
    const turnId = processingIds[0] ?? ids[0] ?? null;
    setCurrentTurnId(turnId);
    setCurrentConsultationCapture(keep);
    emitWorkflowEvent({
      source: 'nanoclaw', name: 'turn', status: 'started', turnId,
      data: { message_count: processingIds.length, provider: config.providerName },
    });
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        config.cwd,
        config.provider.onExchangeComplete?.bind(config.provider),
        prompt,
        continuation,
        config.provider.prefersFreshQuery?.bind(config.provider),
        PROVIDER_RETRY_STALL_MS,
        SUBAGENT_NOTICE_BATCH_MS,
        config.agentGroupId,
        {
          assistantName: config.assistantName,
          providerName: config.providerName,
          configuredModel: config.configuredModel,
          effort: config.effort,
          modelTiers: config.modelTiers,
          agentGroupId: config.agentGroupId,
          skillsDir: config.skillsDir,
          hasContinuation: true,
        },
      );
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
      emitWorkflowEvent({ source: 'nanoclaw', name: 'turn', status: 'completed', turnId, data: { provider: config.providerName } });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);
      // Keep provider details in the normal log only. Workflow receipts are
      // intentionally safe for the Ops Center timeline and must not carry
      // credential-bearing error strings.
      emitWorkflowEvent({ source: 'nanoclaw', name: 'turn', status: 'failed', turnId, data: {
        error: true, error_type: err instanceof Error ? err.constructor.name : 'unknown',
      } });

      if (err instanceof RetryableResponseFormatError) {
        // The exchange remains processing and is intentionally left for the
        // host's stale-claim recovery path. A provider-stall chat notice would
        // be a second user-visible message for the same failed turn.
        log('Response formatting failed after one correction — leaving claim retryable');
        throw err;
      }

      if (err instanceof RetryableQueryError) {
        writeMessageOut({
          id: generateId(),
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({
            text: 'The provider connection stalled. I am restarting this request automatically; you do not need to resend it.',
          }),
        });
        throw err;
      }

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
      // A visible, terminal error is the result for this exchange. Retryable
      // failures take the branch above and deliberately keep their claims.
      markCompleted(processingIds);
    } finally {
      finalizeGrounding(groundingEventId, config.cwd);
      clearCurrentInReplyTo();
      clearCurrentTurnId();
      clearCurrentConsultationCapture();
    }

    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

interface PendingExchange {
  prompt: string;
  messageIds: string[];
  unwrappedNudged: boolean;
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  cwd: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
  prefersFreshQuery?: (text: string) => boolean,
  retryStallMs = PROVIDER_RETRY_STALL_MS,
  subagentNoticeBatchMs = SUBAGENT_NOTICE_BATCH_MS,
  agentGroupId?: string,
  chatCommandContext?: ChatCommandRuntimeContext,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  // Each provider result acknowledges exactly one input exchange. Message IDs
  // remain processing while their prompt is merely queued in the SDK stream;
  // only a corresponding result is allowed to complete them.
  const exchanges: PendingExchange[] = [
    { prompt: initialPrompt, messageIds: [...initialBatchIds], unwrappedNudged: false },
  ];
  const subagentNotices = new SubagentNoticeBatcher((text) => {
    if (routing.channelType === 'agent') return;
    writeMessageOut({
      id: generateId(),
      in_reply_to: routing.inReplyTo,
      kind: 'chat',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({ text }),
    });
  }, subagentNoticeBatchMs);
  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via activity heartbeats + processing
  // claim age (see src/host-sweep.ts). Provider events renew activity; merely
  // keeping this warm stream open does not.
  let pollInFlight = false;
  let endedForCommand = false;
  let endedForDirective = false;
  let corruptionStreak = 0;
  const followupGroundingIds: number[] = [];
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand || endedForDirective) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();
        const selfAddressed = pending.filter((m) => isSelfAddressedMessage(m, agentGroupId));
        if (selfAddressed.length > 0) {
          markCompleted(selfAddressed.map((m) => m.id));
          log(`Discarded ${selfAddressed.length} self-addressed agent control message(s) during active query`);
        }
        const activePending = pending.filter((m) => !isSelfAddressedMessage(m, agentGroupId));

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        if (activePending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        let newMessages = activePending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;
        if (!hasWakeTrigger(newMessages)) return;

        // Do not push scheduled work into an interactive turn. Let the active
        // query finish, then the outer loop will pick up the task as a fresh
        // initial batch and clear the stored continuation above.
        if (hasScheduledTask(newMessages)) {
          log('Scheduled task arrived during active query — ending query before fresh task run');
          query.end();
          return;
        }

        // Consultation protocol replies are timing-independent: archive and
        // aggregate them even when they land during an already-open provider
        // stream. Deterministic responses are completed here; a completed
        // quorum becomes one rewritten synthesis prompt for the active query.
        if (chatCommandContext) {
          const palette = applyConsultCommands(newMessages, {
            assistantName: chatCommandContext.assistantName,
            agentGroupId: chatCommandContext.agentGroupId,
            providerName: chatCommandContext.providerName,
            configuredModel: chatCommandContext.configuredModel,
            effort: chatCommandContext.effort,
            modelTiers: chatCommandContext.modelTiers,
            destinations: getAllDestinations(),
          });
          if (palette.handledIds.length > 0) {
            markProcessing(palette.handledIds);
            markCompleted(palette.handledIds);
          }
          newMessages = palette.messages;
          if (newMessages.length === 0) return;
        }

        // A batch carrying a per-turn model directive (e.g. [tier:high])
        // cannot take effect on a running query — the model is fixed at
        // query creation. Leave it pending and wind down the active query
        // (end, not abort: let any in-flight turn finish); the main loop
        // then picks it up as the initial batch of a fresh query where the
        // directive applies.
        if (prefersFreshQuery?.(newMessages.map((m) => m.content).join('\n'))) {
          log('Follow-up carries a model directive — ending active query so it starts a fresh one');
          endedForDirective = true;
          query.end();
          return;
        }

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        setCurrentConsultationCapture(keep);
        const grounding = buildGrounding(cwd, keep);
        const groundingId = recordGrounding(keptIds, grounding);
        if (groundingId != null) followupGroundingIds.push(groundingId);
        const prompt = prependGrounding(formatMessages(keep), grounding);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        const disposition = await query.push(prompt);
        // A successful push establishes one bounded activity anchor for the
        // new exchange. Only later provider events may renew it; an open or
        // hung stream cannot keep the container alive by itself.
        touchHeartbeat();
        if (disposition === 'coalesced' && exchanges[0]) {
          // Codex turn/steer folds this input into the current turn and emits
          // one combined result. Keep one exchange so that result retires all
          // contributing message claims together.
          exchanges[0].prompt += `\n\n--- steered follow-up ---\n${prompt}`;
          exchanges[0].messageIds.push(...keptIds);
        } else {
          // Claude and legacy providers emit one result per pushed prompt.
          exchanges.push({ prompt, messageIds: keptIds, unwrappedNudged: false });
        }
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  let retryDeadlineAt: number | null = null;
  const iterator = query.events[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextProviderEvent(iterator, query, retryDeadlineAt, retryStallMs);
      if (next.done) break;
      const event = next.value;
      retryDeadlineAt = event.type === 'error' && event.retryable ? Date.now() + retryStallMs : null;
      handleEvent(event, subagentNotices);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        const exchange = exchanges[0];
        let exchangeComplete = true;
        if (event.text) {
          const { sent, hasUnwrapped } = dispatchResultText(event.text, routing);
          if (sent === 0 && event.isError === true) {
            // Non-retryable error turn (e.g. a 403 billing_error) with no
            // <message> envelope: deliver the notice instead of dropping it as
            // scratchpad, and skip the re-wrap nudge — it would just re-hammer
            // the failing gateway turn after turn.
            deliverErrorResult(event.text, routing);
            notifyExchangeComplete(onExchangeComplete, {
              prompt: exchange?.prompt ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: 'error',
            });
          } else {
            const willRetryWrapping = hasUnwrapped && exchange !== undefined && !exchange.unwrappedNudged;
            const wrappingFailed = hasUnwrapped && exchange?.unwrappedNudged === true;
            if (wrappingFailed) {
              log('Provider returned another unwrapped response after the one-shot correction');
              throw new RetryableResponseFormatError();
            }
            notifyExchangeComplete(onExchangeComplete, {
              prompt: exchange?.prompt ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: hasUnwrapped ? 'undelivered' : 'completed',
            });
            if (willRetryWrapping) {
              exchange.unwrappedNudged = true;
              const destinations = getAllDestinations();
              const names = destinations.map((d) => d.name).join(', ');
              query.push(
                `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                  `Your destinations: ${names}. ` +
                  `Please re-send your response with the correct wrapping.</system>`,
              );
            }
            // The wrapping-retry result answers the SAME user prompt — keep it
            // queued and processing so the retry archives and acknowledges the
            // original exchange, not the nudge text.
            if (willRetryWrapping) exchangeComplete = false;
          }
        }
        if (exchangeComplete && exchange) {
          markCompleted(exchange.messageIds);
          exchanges.shift();
        }
      } else if (event.type === 'file') {
        deliverHarnessFile(event.path, routing);
      }
    }
    if (exchanges.length > 0 && endedForCommand) {
      // A runner slash command deliberately cancels the active turn so it can
      // execute at the canonical outer-loop boundary. This is an explicit
      // user interruption, not provider success, but the cancelled exchange
      // must be retired or it would replay after commands such as /clear.
      for (const exchange of exchanges) markCompleted(exchange.messageIds);
      exchanges.length = 0;
    }
    if (exchanges.length > 0) {
      throw new RetryableProviderStreamClosedError(exchanges.length);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: exchanges[0]?.prompt ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
    throw err;
  } finally {
    subagentNotices.flush();
    done = true;
    clearInterval(pollHandle);
    for (const groundingId of followupGroundingIds) finalizeGrounding(groundingId, cwd);
  }

  return { continuation: queryContinuation };
}

async function nextProviderEvent(
  iterator: AsyncIterator<ProviderEvent>,
  query: AgentQuery,
  retryDeadlineAt: number | null,
  retryStallMs: number,
): Promise<IteratorResult<ProviderEvent>> {
  const taggedNext = iterator.next().then(
    (value) => ({ kind: 'event' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  if (retryDeadlineAt === null) {
    const result = await taggedNext;
    if (result.kind === 'error') throw result.error;
    return result.value;
  }

  const remainingMs = Math.max(0, retryDeadlineAt - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), remainingMs);
  });
  const result = await Promise.race([taggedNext, timedOut]);
  if (timer) clearTimeout(timer);
  if (result.kind === 'timeout') {
    query.abort();
    throw new RetryableProviderStallError(retryStallMs);
  }
  if (result.kind === 'error') throw result.error;
  return result.value;
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
): void {
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleEvent(event: ProviderEvent, subagentNotices: SubagentNoticeBatcher): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      subagentNotices.flush();
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      subagentNotices.flush();
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
    case 'subagent_spawn':
      log(`Subagent: ${event.model} — ${event.reason}`);
      subagentNotices.add(event);
      break;
  }
}

/** Deliver a provider-generated file to the batch's reply destination. */
function deliverHarnessFile(filePath: string, routing: RoutingContext): void {
  if (!routing.platformId || !routing.channelType) {
    log(`Dropping harness file ${filePath}: batch has no reply destination`);
    return;
  }
  try {
    const { filename, seq } = enqueueFileOut({
      srcPath: filePath,
      routing: {
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        in_reply_to: routing.inReplyTo,
      },
    });
    log(`Delivered harness file #${seq} → ${routing.channelType}:${routing.platformId} (${filename})`);
  } catch (err) {
    log(`Failed to deliver harness file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Deliver a turn's text straight to the channel the batch arrived on. Used when
 * a turn ends in a provider error (e.g. a non-retryable 403 billing_error) with
 * no <message> envelope: the notice would otherwise be dropped as scratchpad.
 * This is the same user-facing write the outer catch block does, minus the
 * `Error:` prefix — the provider's text is already a user-facing message.
 */
function deliverErrorResult(text: string, routing: RoutingContext): void {
  log('Error result with no <message> envelope — delivering to channel');
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
function dispatchResultText(text: string, routing: RoutingContext): { sent: number; hasUnwrapped: boolean } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped };
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
