/**
 * a2a delegation ledger — durable, queryable record of every cross-group
 * agent route. See migration 022 for the schema and the request/reply join
 * convention. Writes happen inside `performAgentRoute` and are best-effort:
 * a ledger failure must never fail message delivery (callers wrap in
 * try/catch).
 */
import { getDb } from '../../../db/connection.js';

export interface DelegationRecord {
  ts: string;
  from_group: string;
  to_group: string;
  from_session: string;
  to_session: string;
  a2a_msg_id: string;
  in_reply_to: string | null;
  tier: string | null;
  escalation: string | null;
  summary: string;
  file_count: number;
}

const TIER_RE = /\[tier:\s*(high|medium|low)\s*\]/i;
const ESCALATE_RE = /\[escalate(?::\s*([^\]]{1,300}))?\]/i;
const SUMMARY_MAX = 200;

/**
 * Extract the routing signals the delegation protocol defines: an optional
 * `[tier:X]` directive on the request leg and an optional `[escalate: why]`
 * block on the reply leg. Also produces the truncated summary stored in the
 * ledger (whitespace-collapsed head of the message text).
 */
export function parseDelegationSignals(text: string): {
  tier: string | null;
  escalation: string | null;
  summary: string;
} {
  const tierMatch = text.match(TIER_RE);
  const escMatch = text.match(ESCALATE_RE);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return {
    tier: tierMatch ? tierMatch[1].toLowerCase() : null,
    escalation: escMatch ? escMatch[1]?.trim() || 'unspecified' : null,
    summary: collapsed.length > SUMMARY_MAX ? `${collapsed.slice(0, SUMMARY_MAX)}…` : collapsed,
  };
}

export function recordDelegation(row: DelegationRecord): void {
  getDb()
    .prepare(
      `INSERT INTO a2a_delegations
         (ts, from_group, to_group, from_session, to_session, a2a_msg_id, in_reply_to, tier, escalation, summary, file_count)
       VALUES
         (@ts, @from_group, @to_group, @from_session, @to_session, @a2a_msg_id, @in_reply_to, @tier, @escalation, @summary, @file_count)`,
    )
    .run(row);
}
