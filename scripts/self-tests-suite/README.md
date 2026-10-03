# self-tests-suite

Live, end-to-end validation suites that exercise a **running** NanoClaw agent
group through the real host path (routed `cli.sock` send → container → provider
→ session DBs). Unlike `pnpm test` (unit, no host), these confirm behavior in
the actual running environment.

Fork-only (`scripts/`), so it stays out of upstream-tracked code. Reuses the
Ops Center web-chat plumbing (`ops-center/chat.ts`) for the send path and the
provider ground-truth stores for verification.

## Usage

```bash
# list suites
pnpm exec tsx scripts/self-tests-suite/run.ts list

# run a suite against a group (host service must be running)
pnpm exec tsx scripts/self-tests-suite/run.ts model-routing --group ag-errand-runner
pnpm exec tsx scripts/self-tests-suite/run.ts model-routing --group ag-errand-runner --json
pnpm exec tsx scripts/self-tests-suite/run.ts model-routing --group ag-errand-runner --timeout 90000
```

Exit code is `0` when every case passes, non-zero otherwise — usable in
`scripts/fork-regression.sh`.

## Suites

### model-routing-test-suite (`suites/model-routing.ts`)

Validates that a group's model **tiers** route as configured. Generic — reads
the group's provider + `model_tiers` from the central DB and probes each path,
asserting against the model the provider *actually recorded* (never the agent's
self-reported name, which a weak model will get wrong):

| case | sends | must run on |
|------|-------|-------------|
| `default/plain` | a plain message (no directive) | the **default** tier |
| `directive/{high,medium,low}` | `[tier:X] …` | tier X |
| `command/{hi,mid,low,default}` | `/model X …` | tier X (default → default) |
| `punct/{low-dot,mid-comma}` | `/model low.` , `/model mid,` | low / medium (must not error) |

Ground truth per provider (`lib/truth.ts`):
- **opencode** → `opencode-xdg/opencode/opencode.db`, `message.data.modelID`
- **claude** → SDK transcript JSONL under `.claude-shared/projects/`, `message.model`
- **codex** → rollout JSONL under `.codex-shared/sessions/`, `turn_context.payload.model` after the task reaches `task_complete`

Each probe consumes one real model turn on the group's provider. When the web
session must be created, its warm-up reply completes before the first probe so
Codex cannot coalesce the probe into the warm-up turn.

## Adding a suite

1. Create `suites/<name>.ts` exporting a `run(agentGroupId, groupName, opts)`.
2. Register it in `SUITES` in `run.ts`.
3. Reuse `lib/` (`group.ts` config, `truth.ts` ground-truth, `probe.ts` transport).

## Files

```
run.ts                 umbrella CLI + report table
suites/model-routing.ts model-routing-test-suite
lib/group.ts           read provider + tiers; model-match normalization
lib/truth.ts           provider ground-truth (which model ran)
lib/probe.ts           routed send + delivered-reply capture
```
