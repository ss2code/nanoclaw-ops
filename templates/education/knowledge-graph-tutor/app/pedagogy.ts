export const PEDAGOGIES = [
  'worked_example',
  'socratic_questioning',
  'retrieval_practice',
  'analogy',
  'error_analysis',
  'spaced_review',
  'interleaving',
  'visual_explanation',
] as const;

export type Pedagogy = typeof PEDAGOGIES[number];

export interface PedagogySignals {
  dueReview: boolean;
  activeMisconception: boolean;
  attemptCount: number;
  lastOutcome?: string;
  hintedRatio: number;
  relatedEligibleCount: number;
  visualPreference: boolean;
  analogyPreference: boolean;
  sourceQuestionAvailable?: boolean;
  sourceQuestionAttemptCount?: number;
  sourceQuestionLastOutcome?: string;
  sourceAnswerAvailable?: boolean;
}

export interface PedagogyCandidate {
  pedagogy: Pedagogy;
  reason_code: string;
  score: number;
}

/**
 * Produce a bounded choice set. The agent may choose within this ranking, but
 * cannot invent a pedagogy outside the contract or ignore a mandatory review /
 * misconception signal.
 */
export function rankPedagogies(signals: PedagogySignals): PedagogyCandidate[] {
  const score = new Map<Pedagogy, { score: number; reason: string }>(
    PEDAGOGIES.map((pedagogy) => [pedagogy, { score: 0.1, reason: 'general_fit' }]),
  );
  const boost = (pedagogy: Pedagogy, value: number, reason: string) => {
    const current = score.get(pedagogy)!;
    if (value >= current.score) score.set(pedagogy, { score: value, reason });
  };

  if (signals.dueReview) boost('spaced_review', 1, 'due_review');
  if (signals.activeMisconception) boost('error_analysis', 1, 'active_misconception');
  if (signals.sourceQuestionAvailable && signals.attemptCount === 0) {
    boost('socratic_questioning', 0.91, 'source_diagnostic');
  }
  if (signals.sourceQuestionAvailable && signals.attemptCount > 0 && signals.sourceQuestionAttemptCount === 0) {
    boost('retrieval_practice', 0.9, 'unseen_source_question');
  }
  if (signals.sourceQuestionLastOutcome === 'incorrect' && signals.sourceAnswerAvailable) {
    boost('error_analysis', 0.97, 'source_answer_error_analysis');
  }
  if (signals.attemptCount === 0) boost('worked_example', 0.86, 'first_exposure');
  if (signals.lastOutcome === 'incorrect') boost('error_analysis', 0.95, 'recent_incorrect');
  if (signals.lastOutcome === 'partial') boost('socratic_questioning', 0.93, 'partial_understanding');
  if (signals.lastOutcome === 'correct') boost('retrieval_practice', 0.82, 'strengthen_recall');
  if (signals.hintedRatio >= 0.5) boost('socratic_questioning', 0.88, 'fade_hints');
  if (signals.relatedEligibleCount >= 2 && signals.attemptCount >= 2) boost('interleaving', 0.78, 'related_branch_practice');
  if (signals.visualPreference) boost('visual_explanation', 0.92, 'visual_preference');
  if (signals.analogyPreference) boost('analogy', 0.84, 'analogy_preference');
  if (signals.attemptCount >= 1) boost('retrieval_practice', 0.72, 'repeat_evidence');

  return [...score.entries()]
    .map(([pedagogy, value]) => ({ pedagogy, reason_code: value.reason, score: value.score }))
    .sort((a, b) => b.score - a.score || a.pedagogy.localeCompare(b.pedagogy))
    .slice(0, 4);
}

export function isPedagogy(value: string): value is Pedagogy {
  return (PEDAGOGIES as readonly string[]).includes(value);
}
