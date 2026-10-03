import { type ActorContext, requireStudent } from './context';
import { computeFrontier } from './learning';
import { openClass, openStudent } from './store';
import { now, TutorError } from './util';

export type CoachingSlot = 'morning' | 'afternoon';

const POINTS: Record<string, number> = {
  correct: 10,
  partial: 7,
  hinted: 5,
  incorrect: 3,
};

function slot(value: string): CoachingSlot {
  if (value === 'morning' || value === 'afternoon') return value;
  throw new TutorError('slot must be morning or afternoon', 64);
}

function preferenceValue(preferencesJson: string, key: string): unknown {
  try {
    const preferences = JSON.parse(preferencesJson) as Record<string, unknown>;
    return preferences[key];
  } catch {
    return undefined;
  }
}

function dateKey(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(value));
  }
}

function currentStreak(eventDates: string[], today: string, timezone: string): number {
  const unique = [...new Set(eventDates.map((value) => dateKey(value, timezone)))].sort().reverse();
  if (unique.length === 0) return 0;
  const todayDate = new Date(`${today}T00:00:00Z`);
  const latest = new Date(`${unique[0]}T00:00:00Z`);
  const age = Math.round((todayDate.getTime() - latest.getTime()) / 86_400_000);
  if (age > 1) return 0;

  let streak = 1;
  for (let index = 1; index < unique.length; index += 1) {
    const previous = new Date(`${unique[index - 1]}T00:00:00Z`);
    const current = new Date(`${unique[index]}T00:00:00Z`);
    if (Math.round((previous.getTime() - current.getTime()) / 86_400_000) !== 1) break;
    streak += 1;
  }
  return streak;
}

function todayKey(at: string, timezone: string): string {
  return dateKey(at, timezone);
}

function motivationalMessage(displayName: string, points: number, streakDays: number, lastOutcome?: string): string {
  if (streakDays >= 3) return `${displayName}, your ${streakDays}-day learning streak is alive. Keep the chain going with one focused win today.`;
  if (lastOutcome === 'correct') return `Great work, ${displayName}—your last answer moved the scoreboard forward. One more deliberate attempt will build on that progress.`;
  if (lastOutcome === 'partial' || lastOutcome === 'hinted') return `You are close, ${displayName}. Partial progress still counts because it shows exactly what to strengthen next.`;
  if (lastOutcome === 'incorrect') return `Good effort, ${displayName}. Mistakes are useful clues; today’s small challenge is designed to turn the last error into a win.`;
  if (points === 0) return `Welcome, ${displayName}. Your first focused step earns the first points on the board—let’s make it small and finishable.`;
  return `You have already banked ${points} points, ${displayName}. A short, focused session now can unlock the next milestone.`;
}

function badges(attempts: number, streakDays: number, points: number, masteryBands: Array<{ band: string; concepts: number }>): string[] {
  const earned: string[] = [];
  if (attempts >= 1) earned.push('first-step');
  if (attempts >= 5) earned.push('evidence-builder');
  if (streakDays >= 3) earned.push('three-day-streak');
  if (points >= 100) earned.push('century-club');
  if (masteryBands.some((row) => row.band === 'high' && row.concepts > 0)) earned.push('mastery-mover');
  return earned;
}

function workCard(
  frontier: Array<Record<string, unknown>>,
  currentAction: Record<string, unknown> | null,
  assignments: Array<Record<string, unknown>>,
  reviews: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const selected = frontier[0];
  if (!selected && !currentAction) {
    return {
      type: 'consolidation', action_type: 'review', concept_code: null,
      title: 'Consolidate your learning', difficulty: 'medium',
      task: 'Review one idea from this class and explain it in your own words.',
      estimated_minutes: 15,
    };
  }

  const conceptCode = String(selected?.concept_code ?? currentAction?.concept_code ?? '');
  const assignment = assignments.find((row) => String(row.concept_code ?? '') === conceptCode);
  const review = reviews.find((row) => String(row.concept_code ?? '') === conceptCode);
  if (assignment) {
    return {
      type: 'assignment', action_type: 'assignment', concept_code: conceptCode,
      title: selected?.title ?? `Assignment for ${conceptCode}`,
      difficulty: selected?.difficulty ?? 'medium', task: assignment.body,
      due_at: assignment.due_at ?? null, assignment_id: assignment.id, estimated_minutes: 25,
    };
  }
  if (review) {
    return {
      type: 'spaced_review', action_type: 'review', concept_code: conceptCode,
      title: selected?.title ?? conceptCode, difficulty: selected?.difficulty ?? review.difficulty,
      task: `Complete a retrieval check on ${selected?.title ?? conceptCode} without looking at your notes, then explain your reasoning.`,
      review_id: review.id, estimated_minutes: 15,
    };
  }
  if (selected) {
    return {
      type: selected.action_type === 'remediate' ? 'remediation' : 'learning_action',
      action_type: selected.action_type, concept_code: selected.concept_code, display_code: selected.display_code ?? null, title: selected.title,
      difficulty: selected.difficulty,
      task: `Complete one ${selected.difficulty}-difficulty ${selected.action_type} task on ${selected.title} and show your reasoning.`,
      reason: selected.reason, estimated_minutes: selected.action_type === 'teach' ? 25 : 20,
    };
  }
  return {
    type: 'current_action', action_type: currentAction?.action_type ?? 'practice', concept_code: conceptCode,
    title: currentAction?.concept_code ?? conceptCode, difficulty: currentAction?.difficulty ?? 'medium',
    task: currentAction?.prompt ?? `Continue your current task for ${conceptCode}.`, estimated_minutes: 20,
  };
}

export function schedulePlan(root: string, actor: ActorContext): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  let timezone = 'UTC';
  try {
    const row = db.query('SELECT preferences_json FROM profile WHERE id=1').get() as { preferences_json: string } | null;
    const preferred = row
      ? preferenceValue(row.preferences_json, 'timezone') ?? preferenceValue(row.preferences_json, 'coaching_timezone')
      : undefined;
    if (typeof preferred === 'string' && preferred.trim()) timezone = preferred.trim();
  } finally { db.close(); }
  return {
    schema: 1,
    timezone,
    slots: [
      {
        slot: 'morning', label: 'Morning launch', local_time: '07:00', recurrence: '0 7 * * *',
        purpose: 'Review progress, celebrate a win, and set one finishable work block before the afternoon check-in.',
      },
      {
        slot: 'afternoon', label: 'Afternoon finish', local_time: '15:00', recurrence: '0 15 * * *',
        purpose: 'Check what was completed, encourage recovery from friction, and set the next concrete step.',
      },
    ],
    first_run_rule: 'Use the next occurrence of each local time as processAfter; if today\'s time has passed, use tomorrow.',
    setup_rule: 'Create one recurring task per slot in this student session; never create a task in the tutor-control or another student session.',
  };
}

export function briefing(root: string, actor: ActorContext, requestedSlot: string): unknown {
  requireStudent(actor);
  const selectedSlot = slot(requestedSlot);
  const at = now();
  const frontier = computeFrontier(root, actor) as { eligible: Array<Record<string, unknown>> };
  const classDb = openClass(root);
  const classConfig = classDb.query(`SELECT class_name,subject,grade_level,age_min,age_max,target_age,explanation_level
    FROM class_config WHERE id=1`).get() as {
      class_name: string; subject: string; grade_level: string; age_min: number; age_max: number;
      target_age: number; explanation_level: string;
    } | null;
  classDb.close();

  const db = openStudent(root, actor.studentId);
  try {
    const profile = db.query('SELECT preferences_json FROM profile WHERE id=1').get() as { preferences_json: string } | null;
    const timezoneValue = profile
      ? preferenceValue(profile.preferences_json, 'timezone') ?? preferenceValue(profile.preferences_json, 'coaching_timezone')
      : undefined;
    const timezone = typeof timezoneValue === 'string' && timezoneValue.trim() ? timezoneValue.trim() : 'UTC';
    const events = db.query(`SELECT at,outcome,event_kind,concept_code FROM learning_events ORDER BY at,id`).all() as Array<{
      at: string; outcome: string; event_kind: string; concept_code: string;
    }>;
    const points = events.reduce((sum, event) => sum + (POINTS[event.outcome] ?? 0) + (event.event_kind === 'review' && event.outcome === 'correct' ? 3 : 0), 0);
    const level = Math.floor(points / 100) + 1;
    const nextLevelPoints = points % 100 === 0 ? 100 : 100 - (points % 100);
    const streakDays = currentStreak(events.map((event) => event.at), todayKey(at, timezone), timezone);
    const masteryBands = db.query('SELECT band,COUNT(*) AS concepts FROM mastery GROUP BY band ORDER BY band').all() as Array<{ band: string; concepts: number }>;
    const assignments = db.query(`SELECT id,concept_code,body,due_at FROM assignments
      WHERE status='pending' ORDER BY COALESCE(due_at,'9999-12-31T23:59:59.000Z'),created_at,id LIMIT 10`).all() as Array<Record<string, unknown>>;
    const reviews = db.query(`SELECT id,concept_code,difficulty,due_at FROM review_schedule
      WHERE status IN ('pending','delivered') ORDER BY COALESCE(due_at,'9999-12-31T23:59:59.000Z'),created_at,id LIMIT 10`).all() as Array<Record<string, unknown>>;
    const currentAction = db.query(`SELECT concept_code,action_type,prompt,difficulty,status,revision
      FROM current_state WHERE id=1 AND status='pending'`).get() as Record<string, unknown> | null;
    const recent = events.slice(-3).reverse();
    const work = workCard(frontier.eligible ?? [], currentAction, assignments, reviews);
    const todayEvents = events.filter((event) => dateKey(event.at, timezone) === todayKey(at, timezone));

    return {
      schema: 1,
      generated_at: at,
      slot: selectedSlot,
      student: { student_id: actor.studentId, display_name: actor.displayName },
      class: classConfig,
      progress: {
        points, level, streak_days: streakDays, total_attempts: events.length,
        attempts_today: todayEvents.length, last_activity_at: events.at(-1)?.at ?? null,
        last_outcome: recent[0]?.outcome ?? null, mastery_bands: masteryBands,
        active_misconceptions: (db.query(`SELECT COUNT(*) AS n FROM misconceptions WHERE status!='resolved'`).get() as { n: number }).n,
      },
      gamification: {
        points, level, next_level_points: nextLevelPoints,
        points_to_next_level: nextLevelPoints,
        streak_days: streakDays,
        badges: badges(events.length, streakDays, points, masteryBands),
        rules: '10 points for an independent correct answer, 7 partial, 5 hinted, 3 for an incorrect attempt that supplies evidence; a correct delayed review earns 3 bonus points.',
      },
      motivation: {
        message: motivationalMessage(actor.displayName, points, streakDays, recent[0]?.outcome),
        slot_goal: selectedSlot === 'morning'
          ? 'Finish the single next-work card before the 3:00 p.m. check-in.'
          : 'Finish or make a visible attempt on the card before the next morning launch.',
      },
      next_work: work,
      recent_evidence: recent.map((event) => ({ at: event.at, concept_code: event.concept_code, outcome: event.outcome, event_kind: event.event_kind })),
      pending_work_count: assignments.length + reviews.length,
      privacy: 'This card is derived only from the current routing-bound student state.',
    };
  } finally { db.close(); }
}
