import type { Database } from 'bun:sqlite';

import { type ActorContext, requireStudent } from './context';
import { openStudent } from './store';
import { now, sha256, stableId } from './util';

export type TraceStage = 'resolve' | 'frontier' | 'decision' | 'retrieval' | 'assessment' |
  'mastery' | 'misconception' | 'schedule' | 'action' | 'visual' | 'receipt';

export function appendTrace(db: Database, studentId: string, traceId: string, stage: TraceStage, conceptCode: string | null, state: unknown): void {
  const row = db.query('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM learning_traces WHERE trace_id=$trace').get({
    $trace: traceId,
  }) as { sequence: number };
  const stateJson = JSON.stringify(state);
  db.query(`INSERT INTO learning_traces (id,trace_id,sequence,at,stage,concept_code,state_json,state_hash)
    VALUES ($id,$trace,$sequence,$at,$stage,$concept,$state,$hash)`).run({
      $id: stableId('trace', studentId, traceId, String(row.sequence)), $trace: traceId, $sequence: row.sequence,
      $at: now(), $stage: stage, $concept: conceptCode, $state: stateJson, $hash: sha256(stateJson),
    });
}

export function traceTimeline(root: string, actor: ActorContext, traceId?: string, limit = 200): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  try {
    const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = traceId
      ? db.query(`SELECT trace_id,sequence,at,stage,concept_code,state_json,state_hash FROM learning_traces
        WHERE trace_id=$trace ORDER BY sequence LIMIT $limit`).all({ $trace: traceId, $limit: bounded })
      : db.query(`SELECT trace_id,sequence,at,stage,concept_code,state_json,state_hash FROM learning_traces
        ORDER BY at DESC,id DESC LIMIT $limit`).all({ $limit: bounded });
    return (rows as Array<Record<string, unknown> & { state_json: string }>).map((row) => ({
      ...row, state: JSON.parse(row.state_json), state_json: undefined,
    }));
  } finally { db.close(); }
}

export function traceMetrics(root: string, actor: ActorContext): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  try {
    const events = db.query(`SELECT at,concept_code,outcome,event_kind,pedagogy FROM learning_events ORDER BY at,id`).all() as Array<{
      at: string; concept_code: string; outcome: string; event_kind: string; pedagogy: string | null;
    }>;
    const traces = db.query(`SELECT stage,concept_code,state_json FROM learning_traces ORDER BY at,id`).all() as Array<{
      stage: string; concept_code: string | null; state_json: string;
    }>;
    const masteryTraces = traces.filter((trace) => trace.stage === 'mastery').map((trace) => ({
      concept: trace.concept_code, state: JSON.parse(trace.state_json) as { before?: string; after?: string },
    }));
    const transitions = masteryTraces.filter((trace) => trace.state.before !== trace.state.after);
    const firstBand = (band: string) => {
      const turns = new Map<string, number>();
      let index = 0;
      for (const trace of masteryTraces) {
        index += 1;
        if (trace.state.after === band && trace.concept && !turns.has(trace.concept)) turns.set(trace.concept, index);
      }
      return [...turns.values()];
    };
    const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const hinted = events.map((event) => event.outcome === 'hinted' ? 1 : 0);
    const midpoint = Math.ceil(hinted.length / 2);
    const firstHintRate = hinted.slice(0, midpoint).reduce((sum, value) => sum + value, 0) / Math.max(1, midpoint);
    const secondHintRate = hinted.slice(midpoint).reduce((sum, value) => sum + value, 0) / Math.max(1, hinted.length - midpoint);
    const decisions = db.query('SELECT pedagogy FROM teaching_decisions ORDER BY at,id').all() as Array<{ pedagogy: string }>;
    const switches = decisions.slice(1).filter((decision, index) => decision.pedagogy !== decisions[index].pedagogy).length;
    const schedules = db.query(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
      FROM review_schedule`).get() as { total: number; completed: number | null };
    const misconceptions = db.query(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved
      FROM misconceptions`).get() as { total: number; resolved: number | null };
    const frontierTraces = traces.filter((trace) => trace.stage === 'frontier').map((trace) => JSON.parse(trace.state_json) as { newly_unlocked?: unknown[]; blocked?: number });
    const unlocks = frontierTraces.reduce((sum, trace) => sum + (trace.newly_unlocked?.length ?? 0), 0);
    return {
      schema: 1,
      assessable_turns: events.length,
      mastery_transitions: transitions.length,
      mastery_gain_per_assessable_turn: transitions.length / Math.max(1, events.length),
      mean_assessments_to_medium: mean(firstBand('medium')),
      mean_assessments_to_high: mean(firstBand('high')),
      graph_unlocks: unlocks,
      unlocks_per_assessable_turn: unlocks / Math.max(1, events.length),
      average_blocked_concepts_per_frontier: frontierTraces.length
        ? frontierTraces.reduce((sum, trace) => sum + (trace.blocked ?? 0), 0) / frontierTraces.length : 0,
      hint_rate_first_half: firstHintRate,
      hint_rate_second_half: secondHintRate,
      hint_fading_delta: firstHintRate - secondHintRate,
      pedagogy_switch_rate: switches / Math.max(1, decisions.length - 1),
      review_conversion_rate: (schedules.completed ?? 0) / Math.max(1, schedules.total),
      misconception_resolution_rate: (misconceptions.resolved ?? 0) / Math.max(1, misconceptions.total),
      trace_events: traces.length,
    };
  } finally { db.close(); }
}
