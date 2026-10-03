import type { MessageInRow } from './db/messages-in.js';
import { getMessageIn } from './db/messages-in.js';
import { getConfig } from './config.js';
import {
  consultStateDir,
  invokeConsultEngine,
  parseContent,
  type ConsultCapture,
  type ConsultIdentity,
} from './consult-engine-client.js';
import type { WriteMessageOut } from './db/messages-out.js';

let currentCapture: ConsultCapture | null = null;

function identity(requestedTier?: string | null): ConsultIdentity {
  let config;
  try {
    config = getConfig();
  } catch {
    return { providerName: 'claude', configuredModel: 'sonnet' };
  }
  const tierModel = requestedTier && config.modelTiers
    ? config.modelTiers[requestedTier as 'high' | 'medium' | 'low']
    : requestedTier && config.provider === 'claude'
      ? { high: 'opus', medium: 'sonnet', low: 'haiku' }[requestedTier]
      : undefined;
  return {
    assistantName: config.assistantName || undefined,
    agentGroupId: config.agentGroupId || undefined,
    providerName: config.provider,
    configuredModel: tierModel || config.model,
    effort: config.effort,
    modelTiers: config.modelTiers,
  };
}

export function setCurrentConsultationCapture(messages: MessageInRow[]): void {
  // Capture belongs to the current provider exchange, not the lifetime of a
  // long-running stream. An ordinary follow-up must not overwrite the most
  // recent consultation synthesis node.
  currentCapture = null;
  for (const message of messages) {
    const meta = parseContent(message.content).consult;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const value = meta as Record<string, unknown>;
    if (value.kind !== 'synthesis-request') continue;
    if (typeof value.rootId !== 'string' || typeof value.nodeId !== 'string' || typeof value.lens !== 'string') continue;
    currentCapture = { rootId: value.rootId, nodeId: value.nodeId, lens: value.lens };
  }
}

export function clearCurrentConsultationCapture(): void {
  currentCapture = null;
}

/**
 * Preserve remote response correlation and archive local processing at the
 * outbound chokepoint, before the invoking agent can paraphrase either one.
 */
export function processConsultationOutbound(msg: WriteMessageOut, content: string): string {
  const response = parseContent(content);
  if (msg.in_reply_to) {
    const inbound = getMessageIn(msg.in_reply_to);
    if (inbound) {
      const request = parseContent(inbound.content);
      const meta = request.consult;
      if (meta && typeof meta === 'object' && !Array.isArray(meta) && (meta as Record<string, unknown>).kind === 'request') {
        const requestedTier = (meta as Record<string, unknown>).requestedTier;
        const decorated = invokeConsultEngine<Record<string, unknown>>('decorate-response', {
          requestContent: request,
          responseContent: response,
          identity: identity(typeof requestedTier === 'string' ? requestedTier : null),
        });
        return JSON.stringify(decorated);
      }
    }
  }

  if (currentCapture && msg.kind === 'chat' && msg.channel_type !== 'agent') {
    const text = typeof response.text === 'string' ? response.text : '';
    if (text) {
      invokeConsultEngine('capture-processed', {
        stateDir: consultStateDir(),
        capture: currentCapture,
        text,
        identity: identity(),
      });
    }
  }
  return content;
}
