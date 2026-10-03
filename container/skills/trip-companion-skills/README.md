# Trip Companion Skills

This directory is the canonical source tree for the Trip Companion skill suite:

- `trip-core` owns trip identity, lifecycle, roster, decisions, scratchpad notes, assets, and planning-stage UX.
- `trip-planning` owns itinerary candidates, feasibility checks, rollups, validation, and exports.
- `trip-finance` owns shared expenses, splits, balances, settlements, and the finance journal.
- Traveller preferences use the generic `memory` engine directly (scope + open-capture from `memory.config.json`; the always-on recall/capture gate lives in `trip-core`). There is no separate trip-memory skill.
- `trip-docs` owns versioned trip documents and rendered outputs.
- `trip-workflows` owns Trip Companion workflow payloads and draft helpers.

The model judges; scripts compute. The model may parse intent and choose the right command, but lifecycle state, decisions, tallies, finance math, plan validation, memory persistence, document versioning, and workflow payload generation stay script-owned.

## Operator lifecycle

The host-side runbook for setting up, verifying, archiving, restoring, and
retiring a trip is [`docs/trip-companion-lifecycle.md`](../../../docs/trip-companion-lifecycle.md).
Use `/new-trip` for provisioning and wiring, and `/archive-trip` for the
verified final archive-and-purge path.

## Runtime Compatibility

NanoClaw still exposes top-level compatibility aliases under `container/skills/trip-*`. Existing agent-group configs, composed instructions, Claude skill names, and command examples such as `/app/skills/trip-core/scripts/trip-core.ts` continue to work through those aliases. This preserves live groups that already store explicit skill lists in `data/v2.db`.

Keep the aliases until every supported runtime has an explicit suite-aware resolver and all persisted group configs have been migrated deliberately.

## Storage Contract

Trip Companion state lives in the group workspace, not in this source tree:

- `groups/<folder>/trip.db` is the authoritative structured trip store.
- `groups/<folder>/memory.db` is the curated long-term memory store.
- `data/v2.db` owns channel wiring, WhatsApp identities, group membership, session routing, and container skill selection.

Moving or reorganizing the source suite must not move, merge, rewrite, or infer data from those databases. A transparent source-layout migration should require no user-visible chat changes; at most, running containers need a restart to pick up changed instructions or source files.

## Portability Contract

Future host runtimes should treat this suite as a portable product core:

- CLI scripts accept configurable paths such as `--db` and `--dir`.
- SQLite stores are the source of truth and use one writer per group.
- Model instructions are thin orchestration around deterministic commands.
- Host integrations, including NanoClaw grounding, Ops Center, and `trip-admin`, are adapters around the stores and CLIs.
- Cross-skill imports inside the suite should stay relative to sibling packages unless shared code clearly belongs in a `shared/` directory.

## Development

Run individual Bun tests from the canonical source paths:

```bash
bun test container/skills/trip-companion-skills/trip-core
bun test container/skills/trip-companion-skills/trip-planning
bun test container/skills/trip-companion-skills/trip-finance
bun test container/skills/trip-companion-skills/trip-docs
bun test container/skills/trip-companion-skills/trip-workflows
```

The batch eval runner also targets the canonical paths and uses the Trip Goa test group:

```bash
bash scripts/run-skill-evals.sh
```
