---
name: memory-audit
description: Audit NanoClaw scoped memory for health, agent usage, operational schedule drift, and recall quality. Use when an agent or operator asks whether memory is being used effectively, whether daily memory review is running, whether approval/owner policy is wired, or when running a memory-evals.json recall test suite before trusting or changing memory behavior.
---

# Memory Audit

Use this skill to measure memory before making memory-system claims. Prefer the deterministic script first, then add judgment from conversation context only when the script marks a case as needing review.

## Commands

Inside an agent container:

```bash
MA="bun /app/skills/memory-audit/scripts/memory-audit.ts --db /workspace/agent/memory.db --config /workspace/agent/memory.config.json"
$MA health
$MA eval --suite /workspace/agent/memory-evals.json
```

From the repo on the host, pass host paths:

```bash
bun container/skills/memory-audit/scripts/memory-audit.ts \
  --db groups/<your-group>/memory.db \
  --config groups/<your-group>/memory.config.json \
  --inbound data/v2-sessions/<agent-group-id>/<session-id>/inbound.db \
  --conversations groups/<your-group>/conversations \
  health

bun container/skills/memory-audit/scripts/memory-audit.ts \
  --db groups/<your-group>/memory.db \
  --config groups/<your-group>/memory.config.json \
  eval --suite groups/<your-group>/memory-evals.json
```

## Health

Run `health` to check:

- DB/config presence and configured scope.
- `approval.required`, configured owner, and `meta.owner_id`.
- memory totals, status/category mix, access-count distribution, and recent recall hit/miss rates.
- stale recall activity when active memories exist but the last recorded recall is outside the requested `--since-hours` window (24 hours by default).
- failed or legacy scheduled memory tasks when an inbound session DB is provided;
  an absent task in that one DB is reported as schedule-unverified, not proof
  that the agent group has no recurring review elsewhere.
- review evidence coverage; an inbound DB is paired with any mounted conversation archive when present, but the audit still cannot prove pending rows in other sessions were covered.
- pass/warn/fail issues that should be surfaced to the owner.

Health is observational. It does not write memories or fix schedules.

## Eval

Run `eval` against `/workspace/agent/memory-evals.json` when judging effectiveness. The script copies the memory DB to a temp file and calls recall with reinforcement disabled, so live `access_count` is not inflated by the test. If an expected title/content/id no longer exists in the active scoped store, the case is reported as `stale` and the suite returns `warn` rather than mislabeling a retired expectation as a retrieval failure.

Suite format:

```json
{
  "cases": [
    {
      "name": "canary",
      "query": "memory evaluation canary",
      "expectAny": ["Memory evaluation canary"],
      "forbidAny": ["unrelated"]
    }
  ]
}
```

Use `expectAny` for titles, content snippets, or numeric ids that should appear. Use `forbidAny` for stale or wrong facts that must not appear.

## Interpretation

Report memory effectiveness as four separate scores:

- Operational reliability: daily/weekly tasks present and not failing.
- Retrieval quality: eval cases pass without forbidden hits.
- Agent usage: recall/profile events happen when relevant, not just writes.
- Capture quality: proposed writes are accepted by the owner and do not duplicate tasks/rules.

Do not call a memory system effective from write count alone. A healthy system must both retrieve the right facts and show evidence that agents actually invoked recall when prior context mattered. Runtime grounding and model-issued `memory recall` are separate signals: grounding can supply a per-turn snapshot, but it does not prove the model selected or used a semantic recall result.
