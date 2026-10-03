---
name: reflect
description: Run NanoClaw's read-only execution-health digest. Use when the operator says "reflect", "self-improve", "review how the agents are doing", "where are we wasting tokens", or asks about agent cost, failures, cache efficiency, compactions, tool loops, or skill reliability. On-demand only; never schedule it and never change config or code as part of this skill.
---

# Reflect — read-only execution health

This skill diagnoses. It does not propose a change merely because a metric was
printed, and it never applies one.

## Contract

- Read existing traces and Ops Center data only.
- Do not edit instructions, skills, config, or source.
- Do not create proposals, schedules, reminders, or background jobs.
- Do not write `data/reflect-improvements.json`. The digest reads that history,
  but only a separately approved repair workflow may update it with
  `scripts/reflect-ledger.ts`.
- Treat "no action indicated" as a successful result.
- Distinguish complete evidence from missing evidence. An empty report with
  partial evidence is inconclusive, not healthy.

## Run

```bash
pnpm run reflect digest --days 7
```

Optional:

```bash
pnpm run reflect digest --days 14
pnpm run reflect digest --group <agent-group-id>
pnpm run reflect digest --json
```

The command itself makes no model calls and opens `ops.db` read-only.

Ops Center's Reflect and System tabs have a `Run /reflect` control that invokes the
same digest engine with an authenticated, user-triggered request. It keeps the
latest bounded result in `data/reflect-latest.json` and shows a compact summary
there after reloads. The request does not write an ops.db event or change config.

## Interpret

Start with `EVIDENCE`.

- `complete`: an empty signal list means no conservative threshold fired.
- `partial`: report the missing source and stop short of a health conclusion.

Then summarize:

1. Outcomes: ok, degraded, failed, idle.
2. Observed cost per priced working workflow and per successful result.
3. High and medium signals, with the arithmetic already provided.
4. The smallest set of exhibits that explains those signals.
5. Any matching improvement-history entry, especially one already verified or
   later marked regressed.

Reflect reports **workflows**, not raw provider prompt phases. One workflow starts
with the operator's request and may include provider-injected skill prompts and
context-compaction resumes. The Runs page retains those raw turns for debugging.

Tool health distinguishes:

- unresolved errors, which can indicate real breakage; and
- recovered errors, where a later successful tool call and visible workflow
  response conservatively indicate recovery. These are retry tax, not proof
  that the integration failed.

Recovery is a deterministic correlation, not semantic proof. Use the linked
signal-specific exhibits and source traces before assigning a root cause.

The digest looks for:

- failed workflows that consumed work but produced no visible response, while
  treating successfully acknowledged outbound actions as response evidence;
- low prompt-cache hit ratio;
- frequent compaction or rising context;
- scheduled/wake work costing much more than chat;
- repeated identical tool calls;
- tool errors or latency degradation;
- skills repeatedly associated with degraded/failed workflows;
- enabled skills not observed in active groups, reported only as candidates for
  inspection.

## Report

Give the operator:

- whether the evidence was complete;
- the two or three most important findings, or "no action indicated";
- the relevant group, metric, and exhibit;
- what to inspect next.

Do not turn the inspection step into an implementation plan unless the operator
separately asks for one. If a real breakage is found, follow the repository's
root-cause and approval rules before any fix.

## Improvement history handoff

The durable history is `data/reflect-improvements.json`. Reflect reads it and
links current signal ids to prior diagnoses, repairs, verification, or
regressions. This prevents a future investigation from rediscovering the same
issue without context.

Do not update it during diagnosis. After the operator separately approves a
repair and the repair has been verified, the implementation workflow may create
a validated entry JSON and explicitly run:

```bash
pnpm exec tsx scripts/reflect-ledger.ts record --entry /tmp/reflect-improvement-entry.json
```

Record the stable signal ids, root cause, introducing commit when known, changed
files, verification, and before/after metrics. Use `status: "regressed"` when a
previously verified issue returns rather than creating a duplicate diagnosis.
