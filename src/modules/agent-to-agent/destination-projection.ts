/**
 * Refresh the live per-session destination maps after a central ACL change.
 *
 * The central `agent_destinations` table is authoritative for host delivery,
 * while containers read a session-local projection. Keeping this helper in the
 * agent-to-agent module lets ACL managers (generic destinations, app wiring,
 * and delegation templates) share the same live-update behaviour.
 */
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeDestinations } from './write-destinations.js';

export async function projectDestinationsToSessions(agentGroupId: string): Promise<void> {
  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    try {
      writeDestinations(agentGroupId, session.id);
    } catch (err) {
      log.warn('Failed to project destinations to session inbound.db', {
        agentGroupId,
        sessionId: session.id,
        err,
      });
    }
  }
}

export async function projectDestinationsToGroups(agentGroupIds: Iterable<string>): Promise<void> {
  for (const agentGroupId of new Set(agentGroupIds)) await projectDestinationsToSessions(agentGroupId);
}
