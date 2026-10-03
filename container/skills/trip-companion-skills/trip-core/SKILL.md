---
name: trip-core
description: The shared spine of a Trip Companion trip — lifecycle, roster, grounded state, packing list, who's bringing shared gear, readiness, roll call, diary, and highlight of the day. Use for live trip state and assets; do NOT use for money/splits (trip-finance) or itinerary/place building (trip-planning).
---

# trip-core — the shared trip spine

**You judge, the script computes (§10).** You parse language into commands; this script owns every state mutation, the legal-transition table, and the deterministic decision tally. Never invent a stage, count votes, or "remember" what was decided — read it back.

**Ground yourself first, every turn.** Working state lives in `trip.db` (tier 1, ungated, §13), never in your head. At the start of a trip turn, read the recap; it rebuilds the exact state even after a restart.

```bash
TC="bun /app/skills/trip-core/scripts/trip-core.ts --db /workspace/agent/trip.db"
$TC recap          # stage + per-stage roster + open/closed decisions + scratchpad — READ THIS FIRST
$TC status         # one-line trip summary
$TC decision board # open/locked decisions, pending voters, ties, stale items, next actions
$TC catchup        # compact late-joiner brief
$TC booking readiness # booking blockers: open decisions, deadlines, weak sources
$TC help           # stage-aware capability menu
```

## The lifecycle (§11)

Seven stages: `planning → plan_ready → start_trip → on_trip → trip_complete → post_trip → archived`, plus a `cancelled` branch reachable from any pre-trip stage. **Agent proposes → owner confirms.** Transitions are journaled and regressible.

```bash
$TC stage show                              # current stage + legal next moves
$TC stage propose --to plan_ready --by <id> # play it back; does NOT move yet
$TC stage confirm --to plan_ready --by <id> # owner-confirmed move
$TC stage regress --by <id>                 # step back one stage
$TC stage cancel  --by <id>                 # cancel a pre-trip trip → cancelled
```

`plan_ready` is gated by `trip-planning plan validate` passing (the planning skill checks completeness + feasibility) AND owner confirmation. Never mark a plan ready yourself — run the validator and confirm.

## Roster & participation (§12)

One roster; participation varies by stage (planning ≠ on-trip). **Sender ≠ target** — never assume who sent a message is who an action is about; name the target in your playback.

```bash
$TC member add --name Tara --joined 2026-08-14 --by <id>   # [--family <id>] [--aliases a,b] [--excluded] [--platform whatsapp:<digits>@s.whatsapp.net]
$TC member set <id> --left 2026-08-16 --by <id>            # also supports --platform whatsapp:<digits>@s.whatsapp.net
$TC member mentions                                        # internal tag handles derived from roster platform ids
$TC member list ; $TC family add --name Kapoor ; $TC family list
$TC relationship add --member 1 --related 2 --kind spouse --note "Arjun & Diya" --by <id>
$TC participation set --member 11 --stage on_trip --status out --note "can't make the trip itself" --by <id>
$TC participation show --stage planning
```

## Decisions — consensus without spam (§14)

Default to **propose-with-deadline**; poll only when genuinely divided. Cap concurrent open decisions; never poll trivia.

```bash
# propose: "locking X by 9pm unless someone objects" — silence is assent
$TC decision open --question "Lock Goa 14–17 Aug?" --mode propose --commit-by 2026-06-20T21:00:00 --stage planning --by <id>
$TC decision objection --id <d> --member <id>        # someone objects → blocks auto-commit
$TC decision due                                     # propose decisions past commit_by with no objection (auto-commit candidates)
# poll: only when split
$TC decision open --question "Where?" --mode poll --options "Goa|Gokarna|Pondicherry" --stage planning --by <id>
$TC decision vote --id <d> --member <id> --choice Goa
$TC decision tally <d>                               # the SCRIPT counts — never tally yourself
$TC decision close <d> --outcome Goa --by <id>
$TC decisions list
$TC decision board
```

Proxy/mirror votes are first-class state, not scratchpad prose:

```bash
$TC proxy set --member 4 --follows 3 --decision <d> --by <id>
$TC proxy apply --decision <d>
$TC proxy list
```

## Planning-stage user experience

Use these for the user-facing planning cockpit and booking gate:

```bash
$TC catchup
$TC booking readiness
$TC recommendation add --category stay --title "Villa Aroor" --source-url <url> --source-checked-at 2026-06-18 --confidence high --note "call to verify availability"
$TC recommendation list
$TC activity signup --activity "Morning trek" --member 2 --status interested
$TC activity list
```

## Scratchpad — ungated working notes (§13)

Write leanings, vetoes, and "to research" the moment they're said — no approval, instantly durable. This is what survives a restart; curated preferences in the `memory` engine are separate and may lag.

```bash
$TC note add --topic food --note "Maya leans off-beat, quieter" --by <id>
$TC note resolve <id> --by <id> ; $TC notes list
```

## Assets (§16)

```bash
$TC asset index --kind ticket --label "Cruise booking" --path assets/tickets/cruise.pdf --stage planning --by <id>
$TC asset list [--kind ticket]
```

## Packing, gear & readiness

Keep packing, gear, and readiness in `trip.db`, never chat prose. Once the plan locks, offer once to seed a destination-appropriate list, readiness checks, and shared gear. Claims are first-come: relay any script conflict as-is. When the heartbeat reports a readiness gap, @mention only the missing members once, politely.

```bash
$TC packing seed --template beach --by <id> ; $TC packing add --label "Snorkel gear" --per-member --by <id>
$TC gear add --label "Bluetooth speaker" --by <id> ; $TC gear claim <itemId> --member <id> ; $TC gear board
$TC readiness seed --by <id> ; $TC readiness due ; $TC readiness confirm <itemId> --member <id>
$TC readiness done <itemId> --by <id> ; $TC check drop <itemId> --by <id>
```

## Roll-call, day-of concierge & diary

“Everyone here?” or “roll call at the cab” opens a message-based roll-call—never location tracking. Mark the target member even if somebody else says “Maya’s with me”; close it once complete. Use `dayof` for travel-day facts and index photos with their day/place. A natural evening highlight goes in the diary with a short acknowledgement.

```bash
$TC rollcall open --label "Airport T2" --by <id> ; $TC rollcall in --member <id> --note "at security" ; $TC rollcall status ; $TC rollcall close --by <id>
$TC dayof --date 2026-08-15
$TC diary add --date 2026-08-15 --entry "Sunset cruise — dolphins!" --member <id> --by <id>
$TC asset index --kind photo --label "Cruise sunset" --path assets/photos/sunset.jpg --day 2026-08-15 --place <placeId> --by <id>
```

## Heartbeat

Use `$TC heartbeat [--edition morning|evening|auto]` for scheduled check-ins. It returns authoritative JSON: relay only its sections and never recompute figures. Reconcile daily pre-trip, morning/evening on-trip, and three-day post-trip tasks after stage changes; cancel them on archive/cancel.

Create or reconcile (never duplicate) scheduled tasks when the stage changes: one daily pre-trip task using `$TC heartbeat`; two on-trip tasks using `--edition morning` and `--edition evening`; and one three-day post-trip task. The schedule script decides `wakeAgent`; relay only its non-empty JSON sections. Morning is always a useful daily brief; planning only nudges due decisions, pending voters, deadlines, or stale research.

## Confirm before commit

Stage transitions, roster changes, and anything you inferred get played back for a human yes before they touch state. A wrong-but-confident action is the one unacceptable failure (charter §1).

## WhatsApp identities

When a trip member speaks in WhatsApp, link their roster row with `$TC member set <id> --platform whatsapp:<digits>@s.whatsapp.net --by <actor>`. Use the recap's internal mention handles or `$TC member mentions` when directly tagging people (`@<digits>`). Do not tag display names, and do not tag raw WhatsApp LID numbers when a phone-number platform id is known.

## Help — recite on "what can you do?"

> I keep the trip's backbone: where it is in its journey (planning → plan-ready → on-trip → home → archived), who's on it, and what the group has decided or is still deciding. Ask "where are we?" any time — I read it back from my notes, never from memory, so it's always right even after I restart. I move the trip forward only when you confirm, I run quick polls or propose-and-lock decisions so we don't stall, and I jot down leanings and vetoes as we go. Money is my finance side; the day-by-day itinerary is my planning side.
