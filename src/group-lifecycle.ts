import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { getAgentGroup } from './db/agent-groups.js';
import { countDueMessages } from './db/session-db.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { openInboundDb } from './session-manager.js';
import { setAgentGroupDesiredState, type AgentGroupDesiredState } from './agent-group-lifecycle.js';
import type { ActionResult } from './ops-types.js';

export interface GroupLifecycleResult extends ActionResult {
  state?: AgentGroupDesiredState;
  containersStopped?: number;
  wakesRequested?: number;
}

export function stopOrPauseAgentGroup(
  groupId: string,
  desiredState: Extract<AgentGroupDesiredState, 'stopped' | 'paused'>,
  actor = 'host',
): GroupLifecycleResult {
  if (!getAgentGroup(groupId)) return { ok: false, message: `agent group not found: ${groupId}` };
  setAgentGroupDesiredState(groupId, desiredState, actor, `Ops Center ${desiredState}`);
  let containersStopped = 0;
  for (const session of getSessionsByAgentGroup(groupId)) {
    if (session.status !== 'active' || !isContainerRunning(session.id)) continue;
    killContainer(session.id, `agent group ${desiredState} via ${actor}`);
    containersStopped++;
  }
  return {
    ok: true,
    state: desiredState,
    containersStopped,
    message: `${desiredState === 'paused' ? 'Paused' : 'Stopped'} agent group ${groupId}; ${containersStopped} container(s) signalled`,
  };
}

export async function runOrResumeAgentGroup(groupId: string, actor = 'host'): Promise<GroupLifecycleResult> {
  if (!getAgentGroup(groupId)) return { ok: false, message: `agent group not found: ${groupId}` };
  setAgentGroupDesiredState(groupId, 'running', actor, `agent group resumed by ${actor}`);
  let wakesRequested = 0;
  for (const session of getSessionsByAgentGroup(groupId)) {
    if (session.status !== 'active' || isContainerRunning(session.id)) continue;
    const db = openInboundDb(groupId, session.id);
    let due = 0;
    try {
      due = countDueMessages(db);
    } finally {
      db.close();
    }
    if (due > 0) {
      wakesRequested++;
      await wakeContainer(session, `manual ${actor} resume · due work ×${due}`, 'manual');
    }
  }
  return {
    ok: true,
    state: 'running',
    wakesRequested,
    message: `Agent group ${groupId} is runnable; requested ${wakesRequested} wake(s) for queued work`,
  };
}
