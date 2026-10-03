import {
  consultStateDir,
  invokeConsultEngine,
  parseContent,
  shouldRunConsult,
  type ConsultEngineContext,
  type ConsultEngineResult,
} from './consult-engine-client.js';
import type { MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { enqueueFileOut } from './outbox.js';

export interface ConsultCommandBatchResult {
  messages: MessageInRow[];
  handledIds: string[];
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function respond(msg: MessageInRow, response: { text: string; file?: string; filename?: string }): void {
  if (response.file) {
    enqueueFileOut({
      srcPath: response.file,
      filename: response.filename,
      text: response.text,
      routing: {
        platform_id: msg.platform_id || '',
        channel_type: msg.channel_type || 'chat',
        thread_id: msg.thread_id,
        in_reply_to: msg.id,
      },
    });
    return;
  }
  writeMessageOut({
    id: generateId(),
    in_reply_to: msg.id,
    kind: 'chat',
    platform_id: msg.platform_id,
    channel_type: msg.channel_type,
    thread_id: msg.thread_id,
    content: JSON.stringify({ text: response.text }),
  });
}

/** Intercept only /consult and structured consultation protocol messages. */
export function applyConsultCommands(
  messages: MessageInRow[],
  context: ConsultEngineContext,
): ConsultCommandBatchResult {
  const remaining: MessageInRow[] = [];
  const handledIds: string[] = [];

  for (const msg of messages) {
    if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') {
      remaining.push(msg);
      continue;
    }
    const original = parseContent(msg.content);
    const text = typeof original.text === 'string' ? original.text : '';
    if (!shouldRunConsult(text, original)) {
      remaining.push(msg);
      continue;
    }

    let outcome: ConsultEngineResult;
    try {
      outcome = invokeConsultEngine<ConsultEngineResult>('runtime', {
        stateDir: consultStateDir(),
        message: {
          id: msg.id,
          kind: msg.kind,
          text,
          content: original,
          channelType: msg.channel_type,
          platformId: msg.platform_id,
          threadId: msg.thread_id,
        },
        context,
      });
    } catch (error) {
      respond(msg, { text: `Consult runtime error: ${error instanceof Error ? error.message : String(error)}` });
      handledIds.push(msg.id);
      continue;
    }

    if (outcome.action === 'pass') {
      remaining.push(msg);
      continue;
    }
    for (const response of outcome.responses) respond(msg, response);
    for (const outgoing of outcome.outgoing) {
      writeMessageOut({
        id: generateId(),
        in_reply_to: msg.id,
        kind: 'chat',
        platform_id: outgoing.platformId,
        channel_type: outgoing.channelType,
        thread_id: outgoing.threadId,
        content: JSON.stringify(outgoing.content),
      });
    }
    if (outcome.action === 'rewrite') {
      const rewritten = { ...original, ...(outcome.rewrittenContent || {}), text: outcome.rewrittenText || outcome.rewrittenContent?.text || text };
      remaining.push({
        ...msg,
        platform_id: outcome.rewriteRouting?.platformId ?? msg.platform_id,
        channel_type: outcome.rewriteRouting?.channelType ?? msg.channel_type,
        thread_id: outcome.rewriteRouting?.threadId ?? msg.thread_id,
        content: JSON.stringify(rewritten),
      });
    } else {
      handledIds.push(msg.id);
    }
  }
  return { messages: remaining, handledIds };
}
