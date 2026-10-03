# Trip Core Always-On Rules

For any Trip Companion turn, ground yourself from the trip database before answering:

```bash
TC="bun /app/skills/trip-core/scripts/trip-core.ts --db /workspace/agent/trip.db"
$TC recap
```

## Traveller preferences (memory)

Durable traveller/group tastes (diet, pace, budget band, "we prefer nature",
"remember X about me") live in this trip's memory store via the generic `memory`
engine — **not** in `CLAUDE.local.md`. The scope and open-capture policy come
from `memory.config.json`; recall spans the whole store, so scope spelling never
hides a row.

```bash
MEM="bun /app/skills/memory/scripts/memory.ts --db /workspace/agent/memory.db --config /workspace/agent/memory.config.json"
```

**Recall before you suggest — a gate, not a suggestion.** Any message where you
are about to propose a place, food, pace, lodging, or plan starts with
`$MEM recall <2-4 distinctive terms>` (e.g. `recall lodging pace`, `recall food
diet`). The engine auto-widens the match; 0 hits means the group has stated no
preference — say so rather than assuming one.

**Capture durable preferences the moment they are stated** — with `$MEM
remember`, never `CLAUDE.local.md`. If a message says "remember… / note that… /
keep in mind…", you **must** save it. Pass `--by "<sender label>"` so provenance
is stamped (the owner's own statements become `owner-approved`, everyone else
`auto`). After saving, relay the `MEMORY SAVED #<id>` line verbatim — it is your
proof of write. The trip owner curates later with `$MEM approve|reject|forget
<id> --by <owner>`; revise a changed fact in place with `$MEM update <id>`,
never forget-and-recreate.

Use `$TC decision board` for "where are we?", "what is pending?", "who has not voted?", tied decisions, stale decisions, or group convergence. Use `$TC catchup` for late joiners or "summarize the current trip state".

Record proxy or mirror voting as structured state, never as an informal memory: `$TC proxy set --member <follower> --follows <source> [--decision <id>]`, then `$TC proxy apply --decision <id>` for open polls.

Before telling people a plan can be booked, run `$TC booking readiness`. It complements `trip-planning plan validate` by checking open decisions, booking blockers, and source-confidence gaps.

Never reveal raw platform ids in user-facing trip summaries. Use display names from the roster.

Packing, gear, readiness, roll-call, diary, and photo day/place state belong in trip.db via `$TC gear|packing|readiness|rollcall|diary|asset …`, never prose. Trust `$TC heartbeat` and nudge only what it returns.
After each confirmed stage change, reconcile (do not duplicate) the trip heartbeat tasks: daily pre-trip, morning/evening on-trip, and every three days post-trip; cancel on archive/cancel.

For direct WhatsApp tags, use roster-backed phone-number handles only. If a member has `platform_id = whatsapp:<digits>@s.whatsapp.net`, tag them as `@<digits>`. If they only appear as a WhatsApp LID or display name, ask/link the roster first with `$TC member set <id> --platform whatsapp:<digits>@s.whatsapp.net`.
