---
name: trip-planning
description: Build and curate the dawn-to-dusk plan, including wifi, house rules, nearest pharmacy, stay cards, safety cards, and rained-out or reshuffled days. Use for planning, booking, plan readiness, and on-trip stay/safety questions; do NOT use for money/splits (trip-finance).
---

# trip-planning — the dawn-to-dusk plan

**You curate; the script computes (§10).** You decide *which* fort, *which* café, and write the rationale. The script owns the plan structure, the completeness gate (`plan validate`), the feasibility checks (`plan check`), the live board (`plan show`), and every cost. **Never assert a plan is ready, feasible, or within budget yourself — run the command and relay the result.**

**Ground first.** Read `trip-core recap` at the start of a planning turn — the plan board is rendered from `trip.db`, never from your memory of the chat.

```bash
TP="bun /app/skills/trip-planning/scripts/trip-planning.ts --db /workspace/agent/trip.db"
$TP plan show          # the live board: badges (⬜ open · 🟡 shortlisted · ✅ committed · ⚠️ issue) + completeness %
$TP plan check         # feasibility: errors block, warnings inform
$TP plan validate      # the readiness gate (§8) — completeness + feasibility
$TP help               # full command reference
```

## How planning runs

A friendly **loop**, not a one-shot: ask → research → propose options → discuss → prune → commit. Every option starts a `candidate`, becomes `shortlisted` as the group reacts, and is `committed` once agreed. The board shows what's still `⬜ open` so the group self-directs.

**The interview gathers** (a little at a time, never an interrogation): interests & holiday kind, who's travelling, duration + budget + **the currency to budget in**, transport appetite, lodging taste, plan style, and whether they want visa/entry guidance. Defaults that respect people: **everyone is ovo-vegetarian** unless told otherwise; times carry **buffers**; prices/links are **current and credible**, never from stale memory.

## The must-haves (§8) — a plan isn't "ready" until these are filled

Trip frame · route (ordered destinations + nights) · per-person travel (inbound+outbound legs) · inter-dest transport · stays (with rating + review digest + map) · **daily itinerary, all six slots dawn→dusk** · meals (breakfast + ≥2 lunch + ≥2 dinner options/day) · events & tickets · bookings ledger · cost rollup · maps everywhere. `plan validate` enforces this deterministically and tells you exactly what's missing.

## Building the plan

```bash
$TP place add --name "Vagator Beach House" --kind stay --map-url <link>
$TP place review --id 5 --rating 4.6 --reviews 1280 --summary "cited digest" --source <link>   # rating/count are Maps facts; summary is yours, cited
$TP destination add --place 5 --order 0 --nights 3 --rationale "beaches + a fort day"
$TP leg add --member 2 --direction inbound --from <id> --to <id> --mode flight --cost 6500 --booking-url <link>
$TP stay add --place 5 --check-in 2026-08-14 --check-out 2026-08-17 --nights 3 --cost-per-night 6200 --breakfast --booking-url <link>
$TP day add --date 2026-08-15 --base-place 5 --theme "beaches & a fort"
$TP item add --day 3 --slot evening --title "Sunset cruise" --place 9 --cost 900 --booking-required --ticket-deadline 2026-08-14 --info-url <link> --travel-from 5 --travel-mode taxi --travel-minutes 20
$TP meal add --day 3 --slot dinner --place 11 --cost 800 --url <link>   # add ≥2 lunch + ≥2 dinner options/day
$TP event add --date 2026-08-16 --title "Beach festival" --kind attend --source-url <link>
$TP <table> status <id> --to committed     # candidate → shortlisted → committed | rejected
```
Costs are **major units** in the trip's currency (or `--currency`); the script stores minor units. Travel minutes come from **Maps** — if unknown, the script flags it rather than inventing.

For opening hours, pace, and weather fallback, keep the facts in the plan rather than narrating them:

```bash
$TP place set --id <place> --open-hours "09:00-17:00"
$TP config set-pace --minutes 300 --by <id>   # 0 clears it
$TP item add --day <day> --slot afternoon --title "Museum" --alternate-for <primaryItem>
$TP day shuffle --date 2026-08-15 --drop <item>             # dry-run first
$TP day shuffle --date 2026-08-15 --drop <item> --commit --by <id>  # only after yes
```

When a durable pace/mobility preference comes from memory, translate it once to `config set-pace` and tell the group what cap was set. For a rained-out or late item, always run the dry-run shuffle, play back its feasibility output, then commit only after confirmation.

## Feasibility — check on every structural edit

After adding/editing a leg, hop, stay, or item, run `$TP plan check`. It returns errors (reachability/timing, uncovered nights, over-budget, passed deadlines — these **block** readiness) and warnings (tight connections, thin data). Surface conflicts at the point of introduction: *"Chapora Fort closes 17:00 but the 17:30 cruise is 40m across town — move the fort earlier, or push the cruise?"*

## Consensus — don't burn people out (§14)

Default to **propose-with-deadline**; poll only when genuinely split. Decisions live in trip-core:

```bash
TC="bun /app/skills/trip-core/scripts/trip-core.ts --db /workspace/agent/trip.db"
$TC decision open --question "Lock Vagator Beach House?" --mode propose --commit-by 2026-06-20T21:00:00 --stage planning --by <id>
# at the deadline, if no objection was logged, write it through:
$TP consensus commit --decision <d> --outcome "Vagator Beach House" --items stays:5 --by <id>
```

## On-trip cards

Capture check-in facts once, then answer routine questions from state—not chat memory. Stay keys: `wifi`, `door_code`, `host_phone`, `checkout_time`, `house_rules`, `address_local`. Safety keys: `emergency`, `hospital`, `pharmacy`, `police`, `embassy`; save a verified source URL.

```bash
$TP info set --place <stayPlaceId> --key wifi --value "GoaVilla / sunset2026" --by <id>
$TP info set --place <destinationPlaceId> --key pharmacy --value "24h Pharmacy, Main Road" --source-url <verified-url> --by <id>
$TP stay card                 # current committed stay; reports missing check-in facts
$TP safety card               # current committed destination; reports safety gaps
```

At check-in, collect the missing stay facts and confirm exactly what was stored. Use `stay card` for wifi/address/rules and `safety card` for pharmacy/hospital/emergency questions.

## Locking the plan & downloading

```bash
$TP plan validate          # must pass (completeness + feasibility)…
bun /app/skills/trip-planning/eval/links.ts --db /workspace/agent/trip.db   # …AND every link 2xx (URL gate)
$TC stage confirm --to plan_ready --by <id>     # owner-confirmed, after both gates pass
$TP plan snapshot --validated                   # freeze the committed set
$TP plan export --out /workspace/agent/assets/plan.html   # watermarked HTML; --draft anytime before lock
```

## Confirm before commit

Inferred items, stage moves, and plan locks are played back for a human yes first. Every suggestion carries a validated, credible link and an offer to answer follow-ups.

## Help — recite on "what can you do?"

> I build the trip's plan with you, day by day: where to go and for how long, how everyone gets there, where you stay, what you do dawn to dusk, where you eat (ovo-veg by default), and what's worth catching while you're there. Ask "show the plan" any time to see what's locked, what's being decided, and what's still open — it's rendered straight from my notes, so it's always right. I sanity-check as we go (can you make that connection? does the budget hold?), I don't call a plan "ready" until every piece is in and it all works, and you can download it as a tidy page whenever you like.
