/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { recoverAgentGroupLifecycle } from './agent-group-lifecycle.js';
import { countDueMessages } from './db/session-db.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { clearProviderContinuations } from './session-continuations.js';
import { openInboundDb, openOutboundDbRw, writeSessionMessage } from './session-manager.js';

function clearSessionContinuations(agentGroupId: string, sessionId: string): void {
  const db = openOutboundDbRw(agentGroupId, sessionId);
  try {
    clearProviderContinuations(db);
  } finally {
    db.close();
  }
}

/**
 * Kill all running containers for an agent group and respawn them.
 *
 * Only targets sessions that actually have a running container.
 * If `wakeMessage` is provided, each session gets an on_wake message
 * (picked up only by the fresh container's first poll) and a
 * wakeContainer call on exit. If `fresh` is true, provider continuation
 * state is cleared after the old container exits and the replacement is
 * woken without a synthetic control message. Without either option,
 * containers are killed and only come back on the next real user message.
 */
export function restartAgentGroupContainers(
  agentGroupId: string,
  reason: string,
  wakeMessage?: string,
  fresh = false,
): number {
  const activeSessions = getSessionsByAgentGroup(agentGroupId).filter((s) => s.status === 'active');
  const sessions = activeSessions.filter((s) => isContainerRunning(s.id));

  // An idle session has no container that needs sequencing. It is therefore
  // safe to clear its provider continuation immediately, so "fresh" remains
  // reliable even when the group is already stopped between turns.
  if (fresh) {
    for (const session of activeSessions) {
      if (!isContainerRunning(session.id)) {
        clearSessionContinuations(session.agent_group_id, session.id);
      }
    }
  }

  // A successful operator restart can be a no-op when the group is already
  // idle. Reconcile any stale error left by the container that previously
  // exited so the dashboard reflects the successful recovery.
  if (sessions.length === 0) {
    recoverAgentGroupLifecycle(agentGroupId, 'ncl restart');
  }

  for (const session of sessions) {
    if (wakeMessage && !fresh) {
      writeSessionMessage(agentGroupId, session.id, {
        id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: agentGroupId,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: wakeMessage,
          sender: 'system',
          senderId: 'system',
        }),
        onWake: 1,
      });
    }
    // Always respawn after the kill when there is anything to process: an
    // explicit wake message, or in-flight messages the dying container had
    // claimed. Without this, a provider switch mid-conversation leaves the
    // claimed messages dark until the next inbound or a slow sweep backoff.
    const hasPending = countDueMessages(openInboundDb(session.agent_group_id, session.id)) > 0;
    killContainer(
      session.id,
      reason,
      fresh || wakeMessage || hasPending
        ? () => {
            if (fresh) {
              // The callback runs only after killContainer confirms the old
              // process has exited, avoiding a cross-process SQLite write
              // while the container still owns outbound.db.
              clearSessionContinuations(session.agent_group_id, session.id);
            }
            const s = getSession(session.id);
            if (s) wakeContainer(s);
          }
        : undefined,
    );
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: sessions.length });
  }
  return sessions.length;
}
