/**
 * Runtime adapter for the pure chat command palette.
 *
 * Keeping DB writes and routing here leaves poll-loop.ts with one small hook,
 * reducing the merge surface when upstream changes the runner lifecycle.
 */
import {
  discoverEnabledSkills,
  extractChatText,
  handleChatCommand,
  replaceChatText,
} from './chat-commands.js';
import { getAllDestinations } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { extractRouting } from './formatter.js';
import type { ModelTiers } from './providers/types.js';
import { applyConsultCommands } from './consult-command-runtime.js';

export interface ChatCommandRuntimeContext {
  assistantName?: string;
  providerName: string;
  configuredModel?: string;
  effort?: string;
  modelTiers?: ModelTiers;
  agentGroupId?: string;
  skillsDir?: string;
  hasContinuation: boolean;
}

export interface ChatCommandBatchResult {
  messages: MessageInRow[];
  handledIds: string[];
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function respond(msg: MessageInRow, text: string): void {
  const routing = extractRouting([msg]);
  writeMessageOut({
    id: generateId(),
    in_reply_to: msg.id,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/** Apply the fleet command palette to a pending batch. */
export function applyChatCommands(
  messages: MessageInRow[],
  context: ChatCommandRuntimeContext,
): ChatCommandBatchResult {
  const enabledSkills = discoverEnabledSkills(context.skillsDir);
  const destinations = getAllDestinations();
  const consultation = applyConsultCommands(messages, {
    assistantName: context.assistantName,
    agentGroupId: context.agentGroupId,
    providerName: context.providerName,
    configuredModel: context.configuredModel,
    effort: context.effort,
    modelTiers: context.modelTiers,
    destinations,
  });
  const remaining: MessageInRow[] = [];
  const handledIds: string[] = [...consultation.handledIds];

  for (const msg of consultation.messages) {
    if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') {
      remaining.push(msg);
      continue;
    }
    const result = handleChatCommand(extractChatText(msg.content), {
      assistantName: context.assistantName,
      providerName: context.providerName,
      configuredModel: context.configuredModel,
      modelTiers: context.modelTiers,
      enabledSkills,
      destinations,
      hasContinuation: context.hasContinuation,
    });

    if (result.action === 'pass') {
      remaining.push(msg);
      continue;
    }
    if (result.action === 'rewrite') {
      remaining.push({ ...msg, content: replaceChatText(msg.content, result.text) });
      continue;
    }
    if (result.action === 'respond') {
      respond(msg, result.text);
      handledIds.push(msg.id);
      continue;
    }

    if (!result.destination.agentGroupId) {
      respond(msg, `Cannot route @${result.destination.name}: destination has no agent group id.`);
      handledIds.push(msg.id);
      continue;
    }
    writeMessageOut({
      id: generateId(),
      in_reply_to: msg.id,
      kind: 'chat',
      platform_id: result.destination.agentGroupId,
      channel_type: 'agent',
      thread_id: null,
      content: JSON.stringify({ text: result.text }),
    });
    respond(msg, result.acknowledgement);
    handledIds.push(msg.id);
  }

  return { messages: remaining, handledIds };
}
