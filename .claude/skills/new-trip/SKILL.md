---
name: new-trip
description: Create, inspect, update, or delete a Trip Companion trip (agent group + wiring + members) from a validated JSON config. Use when the user wants to set up a new trip, check trip infrastructure status, add members or chat wires to a trip, or tear one down. Triggers on "new trip", "create a trip", "trip status", "wire this chat to the trip", "delete the trip".
---

# /new-trip — config-driven trip instantiation

For the complete setup-to-teardown operator runbook, see
`docs/trip-companion-lifecycle.md`. Use `/archive-trip` for a completed trip;
it verifies the archive and performs the final purge. `delete` is a lower-level
operation for other group-retirement cases, not a second step after archive.

The engine is `scripts/trip-admin.ts` (host-side; run from the repo root). A trip = one agent group + chat wires + member allowlist + model. The config is one JSON file; everything is validated before any write, and `apply` is idempotent — re-running it converges the DB to the config.

```bash
pnpm exec tsx scripts/trip-admin.ts apply  trips/<name>.trip.json   # create or update
pnpm exec tsx scripts/trip-admin.ts status <trip-id>  [--json]      # infra + ledger status
pnpm exec tsx scripts/trip-admin.ts list
pnpm exec tsx scripts/trip-admin.ts delete <trip-id> --yes          # keeps groups/<folder>/ on disk
```

## Workflow

1. **Gather**: trip name, model (`sonnet` for live trips, `haiku` for plumbing tests), members (platform ids like `telegram:5550001111` — for Telegram users, get the numeric id from `ncl users list` or an existing message), and wires (CLI platform-id for dev; Telegram group chat id once the group exists).
2. **Write the config** to `trips/<name>.trip.json` (start from `trips/example.trip.json`). Real configs are gitignored; only the example is tracked.
3. **`apply`**, show the user the output, then **`status`** to confirm: every wire must show a destination (the status output warns `NO DESTINATION` otherwise) and the expected members.
4. For a Telegram wire where the group chat doesn't exist yet: have the user create the Telegram group with the bot first, find the chat id via `pnpm exec tsx scripts/q.ts data/v2.db "select id, platform_id, name from messaging_groups where channel_type='telegram'"`, put it in the config, re-`apply`.
5. For a **WhatsApp** wire: always have the user create a **brand-new** WhatsApp group when you ask for it (bot + the first member only) — **never reuse or add the bot to a pre-existing/active group.** The new group's JID isn't written to the DB on its own (`onMetadata` only logs it), so after the user sends any message in the group, read the JID from the host log: `grep "Channel metadata discovered" logs/nanoclaw.log | grep whatsapp | tail` — it's the newest `<digits>@g.us` that isn't an already-known group. Put it in the config, re-`apply`. Then add later participants **one at a time**, checking after each that the bot's reply renders for the newest member (not "⏳ Waiting for this message").
   - **Fresh-group signal (load-bearing):** on the correct path, **no Telegram approval lands on the owner agent (Jeeves)**. If the owner *does* get an unknown-sender/group approval prompt, the bot was wired into an existing/active group instead of a fresh one — that path has correlated with the Baileys group-send failure ("Waiting for this message"). Back out and create a fresh group rather than approving through it.
6. After changing `model`, restart the trip's containers: `pnpm exec tsx src/cli/client.ts groups restart --id <trip-id>`.

## Notes

- Config rules are enforced by the script: trip id must start with a letter (OneCLI identifier), members/wires non-empty, user ids `<channel>:<handle>`, valid engage regex. CLI wires default to `pattern`/`@trip` (the CLI adapter has no mention concept); Telegram/WhatsApp wires default to `mention` (the trip-admin parser default for non-CLI channels — engage only on an explicit @mention).
- `delete` cascades DB rows but intentionally leaves `groups/<folder>/` (the ledger and memory) on disk.
- The trip agent itself answers "@trip status" in its chats (ledger + infra) — that path needs no host access.
