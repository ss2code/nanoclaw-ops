---
name: new-knowledge-graph-tutor
description: Create, inspect, ingest coursework into, evaluate, improve, and remove a NanoClaw knowledge-graph tutor consisting of one class/subject agent group, one tutor-control chat, and separate shared-mode student chats. Use for tutor instantiation, wiring, persona simulations, iterative pedagogy/graph/mastery evals, serialized live UAT, Telegram rollout, Base_doc ingestion, tutor status, or safe teardown.
---

# Knowledge-graph tutor lifecycle

Use the config-driven host script from the repository root. It stamps the local template, creates routing bindings and separate student databases, wires every chat with `session_mode=shared`, runs optional coursework through the proposal/commit pipeline, and emits receipts.

For an operator-led Telegram rollout, the **Tutor Foundry** tab in Ops Center is
only a provisioning and lifecycle surface. It collects the canonical config,
uses the same pairing authorities, and exposes class pause/resume/cleanup
without requiring JSON or CLI use. It is not the tutor's pedagogical dashboard
and must not be presented as one. Locally, the operator surface is:

```text
http://127.0.0.1:10333/tutor-foundry
```

The optional loopback-only development launcher remains
`templates/education/knowledge-graph-tutor/ops-center/launch.sh start` on port 10335. Application
files are under `templates/education/knowledge-graph-tutor/ops-center/`; operator drafts and
optional phone/roll metadata stay under ignored
`data/knowledge-graph-tutor-console/`. Configure the Telegram bot through NanoClaw's
normal channel/setup surface; Tutor Foundry owns only tutor-class data,
pairing, and lifecycle actions. Never ask the operator to paste a Telegram
token into chat.

The standardized teaching dashboard lives in the configured tutor-control
messaging channel. The tutor asks for the class dashboard and the agent runs
`admin dashboard --json`, then renders student mastery, authored-question
coverage, blueprint gaps, cohort-safe item quality, revision lineage, and
recommended attention directly in that same conversation. It may link the
detailed report artifact returned by the command. Never require tutor access to
Ops Center for learning insight.

Every student session includes the `proactive-coaching` skill. On the first
student turn it creates two private recurring check-ins—07:00 and 15:00 in the
runtime-declared local timezone—and records a per-slot setup marker in that
student's profile. The check-ins call the routing-scoped `coaching briefing`
command, celebrate evidence-backed progress, and set one bounded task to finish
before the next slot. They must never be created from tutor control or used to
fabricate a learning attempt. See the template skill for the idempotency and
quiet-student rules.

Read `references/uat.md` before a UAT or live-channel rollout. Read `references/evaluation.md` before an eight-persona improvement cycle.

Use the repository's Node-22-safe `./bin/tutor-deploy` wrapper for host-side tutor
lifecycle commands. It resolves the supported Node executable itself, so an
interactive shell currently using Node 24 cannot select the wrong
`better-sqlite3` ABI. `nvm use 22` remains valid for UAT commands that are not
covered by the wrapper.

## 1. Prepare the configuration

Copy `config-examples/knowledge-graph-tutor.synthetic.json` to an untracked operator file and change:

- `id`, `name`, and `folder` to unique values;
- one class and subject per agent group;
- an explicit `gradeLevel` and `ageRange` (or a class name from which grade can be safely inferred); verify the resolved target age because it becomes the mandatory `ELI <target-age>` contract for all student language and generated questions;
- an explicit pinned `model`; use `claude-haiku-4-5-20251001` for iterative live skill tuning and the intended production model only for the final acceptance comparison;
- the authorized tutor identity and tutor-control channel tuple;
- one student identity and one private messaging-group tuple per student;
- optional coursework paths and graph scope.

Coursework may be Markdown/text/HTML, native or scanned PDF, common image, DOCX,
or PPTX. Intake detects formats from content, preserves the original bytes, and
records extracted/OCR/structured/normalized artifacts. Configure an explicit
OCR provider when scanned material is expected; a successful intake still needs
fixed canonical Tagged Markdown or schema-v1 JSON before graph commit. Tutor
channels can review `ingestion source-list` and retrieve an approved original or
derivative with `ingestion source-get`; student responses must use the returned
safe path through `send_file` or the inline Unicode fallback.

Use CLI channels for deterministic UAT. For Telegram, create the tutor-control group and one private test group per fake student first, let NanoClaw discover their numeric platform IDs, then put those IDs in the config. Keep the tutor, bot, and exactly one fake student in each student group.

Never reuse the supplied Base_doc for automated or manual UAT. Keep it untouched and use the synthetic fixtures under `templates/education/knowledge-graph-tutor/app/test/fixtures/`.

## 2. Validate and instantiate

Run the template tests before any host mutation:

```bash
bun test templates/education/knowledge-graph-tutor/app/test
pnpm exec vitest run scripts/knowledge-graph-tutor-admin.test.ts
```

Apply the config idempotently. The tutor keeps a safe reference to the checked-out
template; app code, instructions, context, and skills are mounted read-only from
that source on every spawn:

```bash
./bin/tutor-deploy apply <config.json>
./bin/tutor-deploy status <agent-group-id> --json
```

For iterative template, skill, runner, or image work, no watcher or repeat
deployment command is required. On the next student/control message NanoClaw
compares the runtime fingerprint, recycles a warm container if needed, rebuilds
the default image when its build inputs changed, and mounts the current source.
For an immediate restart while testing, use
`./bin/tutor-deploy refresh --group <agent-group-id>`.

Require these status facts:

- one tutor-control wire plus one wire per student;
- every wire reports `sessionMode: shared`;
- the approved student count matches the config;
- optional approved coursework produces at least one graph and course revision;
- the runtime root is `groups/<folder>/tutor-app`.
- the live student skill set includes `proactive-coaching/SKILL.md`.
- `doctor --json` reports the intended grade, age range, target age, and explanation level.

## 3. Ingest separately when review is required

Stage without approval first:

```bash
./bin/tutor-deploy ingest <agent-group-id> \
  --document <synthetic-or-user-approved-document> \
  --graph <Class_Subject_Scope_KG> \
  --scope-type <chapter|unit|module|cross-chapter> \
  --scope-label <label>
```

Review the warnings, counts, proposal ID, and proposal hash. Re-run with `--approve` only after the tutor explicitly approves the proposal. The commit receipt must name the exact revision and graph.

For a live Telegram test, use the tutor-control chat's `coursework-ingestion` skill so routing authorization is exercised inside the container.

## 4. Exercise the running container

Send a message to each configured test chat. Confirm `ncl sessions list` shows distinct sessions for the same agent group. In each chat, ask for `help`; student help must omit tutor commands.

Run the canary, evidence, shared-course, tutor-denial, and targeted-command tests in `references/uat.md`. Do not enrol real students until every blocker passes.

For the deterministic two-student CLI fixture, drive the real host router and
provider and require every state-backed check to pass:

```bash
pnpm exec tsx scripts/knowledge-graph-tutor-uat.ts \
  <config.json> --json
```

For iterative persona evaluation, use the immutable receipt + SQLite ledger workflow in `references/evaluation.md`. Never weaken a mastery, privacy, routing, or provenance gate to improve the score. Run live personas serially and stop group containers between personas. Never allow an implicit provider-default model: the serialized runner must attest that the config, central DB, materialized container file, and provider transcript all name the same model.

Use `--checkpoint each-persona` when the operator wants a decision after every persona, or the default `--checkpoint on-quality` to pause only below the advisory threshold. A checkpoint exits `75` with a durable `attention_required` question. Resume unchanged with `--resume`; if the operator chooses a stronger model, preserve the checkpoint and start a fresh comparison run with a new run ID and clean disposable state. Never mix models inside one scored receipt.

## 5. Inspect

```bash
./bin/tutor-deploy status <agent-group-id> --json
```

Inside a routed chat, the agent uses:

```bash
bun /workspace/agent/tutor-app/app/cli.ts doctor --json
bun /workspace/agent/tutor-app/app/cli.ts context current --json
bun /workspace/agent/tutor-app/app/cli.ts admin dashboard --json
```

Treat the scoped CLI as the application authority. Never inspect or edit tutor SQLite files directly during operation.

## 6. Clean up

For a disposable UAT instance, remove central state and its exact on-disk group/session directories:

```bash
./bin/tutor-deploy delete <agent-group-id> --yes --purge
```

`--purge` is irreversible and is appropriate only for disposable synthetic instances. Omit it to retain the group directory for recovery. For real student data, export and verify the backup before any purge.

## Failure handling

- A route collision or duplicated tutor/student identity is a configuration error; fix the config before retrying.
- Exit `64` means invalid or forbidden arguments, `65` means proposal validation failure, `66` means not found, `77` means authorization/routing denial, and `78` means uninitialized application state.
- Live-evaluator exit `75` means the group is safely paused at an immutable human-review checkpoint; it is not a failed learning gate.
- A raw textbook source can be inspected and retained by the intake adapters, but it cannot become graph authority as unreviewed prose. Create and review a canonical Base_doc derivative (Tagged Markdown or schema-v1 JSON), then ingest that derivative with provenance and source lineage recorded.
- The MVP enforces application-level isolation. It does not claim protection against arbitrary shell reads in a compromised shared-workspace container.
