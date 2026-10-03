# Iterative tutor evaluation

Use only the synthetic mathematics and science fixtures. Keep the supplied operator Base_doc untouched; it is not a UAT fixture.

## Deterministic lane

Run one immutable iteration:

```bash
bun .claude/skills/new-knowledge-graph-tutor/scripts/evaluate.ts \
  --run-id <stable-cycle-id> --iteration <n> --label <change> \
  --output logs/knowledge-graph-tutor-evals
```

Require 12/12 journeys, 168 steps, at least 250 assertions, all eight pedagogies at least four times, 56 directed privacy probes with zero leaks, 24 tutor-operation checks, zero mastery-validity violations, and quality at least 1.7. Inspect `ledger.db` and the immutable iteration JSON. Compare source hashes; never overwrite a receipt.

Each turn trace records frontier candidates and unlocks, pedagogy ranking/reason, retrieval provenance, assessment, mastery transition, misconception lifecycle, schedules, visuals, and receipts. Compare mastery gain per assessable turn, unlocks per assessable turn, assessments to medium/high, hint-fading delta, review conversion, remediation cost, and pedagogy switch rate. Safety gates dominate aggregate score. The source hash covers the evaluator oracle, its executable tutor dependencies, both curricula, and the active skill/evaluation contracts.

## Test/fix loop

1. Run an iteration and preserve its failures.
2. Classify each failure as application, skill/policy, evaluator oracle, provider, or environment.
3. Write a root-cause note before changing code.
4. Change one policy/mechanism at a time.
5. Run the template tests, then a new numbered iteration under the same run ID.
6. Accept an improvement only when blockers remain zero and no persona or safety counter regresses.

## Serialized live lane

The synthetic config pins `claude-haiku-4-5-20251001`. The runner rejects a missing model before any paid call, compares the requested model to the central DB and materialized `container.json`, then reads the provider JSONL transcript to attest the model that actually answered. Apply the config, then run:

```bash
pnpm exec tsx scripts/knowledge-graph-tutor-live-eval.ts \
  config-examples/knowledge-graph-tutor.eight-persona.synthetic.json <live-run-id> \
  --checkpoint on-quality
```

This sends 48 student and 12 tutor turns for six representative personas. It pauses the group, waits for container quiescence, resumes for the next persona, and fails if more than two containers were observed in a lane. Treat text-quality scoring as advisory; student databases and routing receipts are authoritative.

For operator review after every persona, use `--checkpoint each-persona`. Exit `75` means the group is quiescent and an immutable `checkpoint-NN.json` contains an `attention_required` question with three choices:

1. Continue on the exact same model by rerunning the command with `--resume`.
2. Leave it paused and review the trace/quality evidence.
3. Preserve the checkpoint, purge/reinstantiate clean disposable state, select a stronger explicit model, and start a new run ID for a valid comparison.

The runner refuses a same-run resume after a model change. The final schema-2 receipt records configured, database, materialized and API-reported models plus per-persona model-call counts; any mismatch is a blocker. Purge only the exact disposable group after preserving receipts.
