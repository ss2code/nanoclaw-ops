/**
 * model-routing-test-suite — validates that an agent group's model tiers route
 * as configured. Generic: works on any group by reading its provider + tiers
 * from the central DB, then probing each routing path against provider
 * ground-truth (never the agent's self-reported model name).
 *
 * Paths covered:
 *   - default   : a plain message must run on the configured default tier
 *   - [tier:X]  : an inline runtime directive must run on tier X
 *   - /model X  : the chat command must rewrite → run on tier X
 *   - punctuation: /model low.  and  /model mid,  must still route (not error)
 *
 * The suite drives the live host (routed cli.sock send) and reads the two
 * session DBs + the provider store, so it exercises the real end-to-end path.
 */
import { readGroupRouting, modelsMatch, type GroupRouting, type ModelTiers } from '../lib/group.js';
import { baseline, awaitTurn, modelForCompletedTurn } from '../lib/truth.js';
import { resolveWebSession, outboundCursor, replyAfter, waitForChatReplyRecord, sendViaCliSock } from '../lib/probe.js';

export interface CaseResult {
  name: string;
  path: string;
  sent: string;
  expectTier: 'high' | 'medium' | 'low';
  expectModel: string;
  actualModel: string | null;
  reply: string | null;
  pass: boolean;
  detail: string;
}

export interface SuiteReport {
  suite: 'model-routing';
  agentGroupId: string;
  provider: string;
  tiers: ModelTiers;
  cases: CaseResult[];
  passed: number;
  failed: number;
}

interface CaseSpec {
  name: string;
  path: string;
  send: string;
  expectTier: 'high' | 'medium' | 'low';
}

/** Build the case matrix from a group's tiers. `d` is the default tier name. */
function buildCases(tiers: ModelTiers): CaseSpec[] {
  const d = tiers.default;
  const q = 'reply with the single word: ok';
  return [
    // Bug 1 surface — a plain turn must land on the configured default tier.
    { name: 'default/plain', path: 'no-directive', send: q, expectTier: d },
    // Runtime directive path (provider-side override).
    { name: 'directive/high', path: '[tier:high]', send: `[tier:high] ${q}`, expectTier: 'high' },
    { name: 'directive/medium', path: '[tier:medium]', send: `[tier:medium] ${q}`, expectTier: 'medium' },
    { name: 'directive/low', path: '[tier:low]', send: `[tier:low] ${q}`, expectTier: 'low' },
    // Chat-command path (rewrite → directive).
    { name: 'command/hi', path: '/model hi', send: `/model hi ${q}`, expectTier: 'high' },
    { name: 'command/mid', path: '/model mid', send: `/model mid ${q}`, expectTier: 'medium' },
    { name: 'command/low', path: '/model low', send: `/model low ${q}`, expectTier: 'low' },
    { name: 'command/default', path: '/model default', send: `/model default ${q}`, expectTier: d },
    // Bug 2 surface — trailing punctuation must not break tier parsing.
    { name: 'punct/low-dot', path: '/model low.', send: `/model low. ${q}`, expectTier: 'low' },
    { name: 'punct/mid-comma', path: '/model mid,', send: `/model mid, ${q}`, expectTier: 'medium' },
  ];
}

export interface RunOpts {
  timeoutMs: number;
  pollMs: number;
  settleMs: number;
  log: (s: string) => void;
}

export async function runModelRouting(
  agentGroupId: string,
  groupName: string,
  opts: RunOpts,
): Promise<SuiteReport> {
  const g = readGroupRouting(agentGroupId);
  if (!g.tiers) {
    throw new Error(`group ${agentGroupId} (provider ${g.provider}) has no model tiers — nothing to route-test`);
  }
  const tiers = g.tiers;
  const { sessionDir } = await resolveWebSession(agentGroupId, groupName, {
    warmupMs: opts.timeoutMs,
    pollMs: opts.pollMs,
  });
  opts.log(`session dir: ${sessionDir}`);

  const cases = buildCases(tiers);
  const results: CaseResult[] = [];

  for (const c of cases) {
    const expectModel = tiers[c.expectTier];
    const truthCursor = baseline(g, sessionDir);
    const outCursor = outboundCursor(sessionDir);

    opts.log(`▶ ${c.name.padEnd(18)} send: ${JSON.stringify(c.send)}`);
    await sendViaCliSock(agentGroupId, c.send);

    const [turn, replyRecord] = await Promise.all([
      awaitTurn(g, sessionDir, truthCursor, { timeoutMs: opts.timeoutMs, pollMs: opts.pollMs }),
      waitForChatReplyRecord(sessionDir, outCursor, { timeoutMs: opts.timeoutMs, pollMs: opts.pollMs }).catch(() => null),
    ]);
    const reply = replyRecord?.text ?? replyAfter(sessionDir, outCursor);
    const actualModel = replyRecord
      ? modelForCompletedTurn(g, sessionDir, truthCursor, replyRecord.timestampMs) ?? turn.model
      : turn.model;

    const r = judge(g, c, expectModel, actualModel, turn.timedOut, reply);
    results.push(r);
    opts.log(`  ${r.pass ? '✅ PASS' : '❌ FAIL'}  ${r.detail}`);

    await sleep(opts.settleMs);
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    suite: 'model-routing',
    agentGroupId,
    provider: g.provider,
    tiers,
    cases: results,
    passed,
    failed: results.length - passed,
  };
}

function judge(
  g: GroupRouting,
  c: CaseSpec,
  expectModel: string,
  actualModel: string | null,
  timedOut: boolean,
  reply: string | null,
): CaseResult {
  const base = {
    name: c.name,
    path: c.path,
    sent: c.send,
    expectTier: c.expectTier,
    expectModel,
    actualModel,
    reply,
  };
  if (timedOut || !actualModel) {
    // No model turn ran. If a "/model" case, the reply text usually explains it
    // (e.g. "Unknown model tier …") — surface that as the failure reason.
    const why = reply ? `no model turn; reply: ${truncate(reply)}` : 'no model turn ran before timeout';
    return { ...base, pass: false, detail: `expected ${c.expectTier}=${expectModel} — ${why}` };
  }
  const pass = modelsMatch(g, expectModel, actualModel);
  const detail = pass
    ? `ran on ${actualModel} (${c.expectTier})`
    : `expected ${c.expectTier}=${expectModel}, but ran on ${actualModel}`;
  return { ...base, pass, detail };
}

function truncate(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
