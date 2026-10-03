---
name: proactive-coaching
description: Keep a student moving when they are quiet by scheduling private 07:00 and 15:00 progress check-ins, turning routing-scoped evidence into an encouraging gamified work card, and setting one bounded task for the next slot.
---

This skill is the tutor's autonomous momentum loop. It supplements `student-teaching`; it does not replace evidence, privacy, or mastery rules.

## One-time setup in a student session

On the first ordinary student turn, and whenever `profile current --json` does not show the corresponding marker, run:

1. `context current --json` and confirm `role=student`.
2. `profile current --json`.
3. `coaching schedule-plan --json`.
4. Use the existing `schedule_task` tool twice in this same student session:
   - a morning task at the next local `07:00`, with recurrence `0 7 * * *`;
   - an afternoon task at the next local `15:00`, with recurrence `0 15 * * *`.

Interpret the time in the timezone supplied by the runtime context. The first
run may be tomorrow when today's slot has passed. Each scheduled prompt must
include its slot marker (`PROACTIVE_COACHING slot=morning` or
`PROACTIVE_COACHING slot=afternoon`) and tell the agent to run the matching
`coaching briefing --slot ... --json` command.

After each schedule call returns a host confirmation, persist only that slot's
setup marker with `profile preferences --value`, for example:

```json
{"coaching_morning_schedule_version":1,"coaching_timezone":"Asia/Kolkata"}
```

Never use the tutor-control session or another student's session as the
destination. Do not mark a slot configured before the host confirms it. If a
schedule call fails, explain the operational issue and leave that slot
unmarked so it can be retried safely.

## Scheduled coaching turn

For a prompt containing `PROACTIVE_COACHING`:

1. Run `inbox apply --json`, `context current --json`, and the matching
   `coaching briefing --slot morning|afternoon --json`.
2. Use the returned points, level, streak, recent evidence, misconception
   count, and `next_work` card. Do not invent progress or claim the student
   completed work without a new assessable answer.
3. If the card names a concept, run the normal bounded planning and grounding
   flow: `learning plan-action` with a fresh slot/date idempotency key and
   `course search --trace <same-trace>`. Use the returned pedagogy and snippets
   to make the task understandable, not to dump course text.
4. Send one warm, concise message at the audience profile's ELI target—encouraging but never babyish—containing:
   - a specific celebration or honest acknowledgement of the latest evidence;
   - the current points/level and streak, if non-zero;
   - exactly one finishable work card (normally 15–25 minutes);
   - the finish line before the next slot (15:00 after the morning card, next
     morning after the afternoon card);
   - an invitation to reply with reasoning or a first attempt.
5. Set or preserve the current action for the expected follow-up. Never call
   `learning record-attempt` merely because the scheduled message was sent.

If the student was quiet, say that the next step is still available and make
the restart path easy. Do not shame, threaten, reset a streak, or create a
large backlog. If an assignment or misconception is present, it outranks a
new topic. If no frontier action is available, send a short consolidation or
reflection task and invite the student to ask for help.

The goal is a reliable rhythm: one small commitment, visible progress, and a
fresh evidence-backed next step at every check-in.
