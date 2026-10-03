---
name: trip-finance
description: Track and split shared trip expenses, settlements, and chase settlements after a trip. Use for costs, receipts, balance/settle-up questions, repayments, fixes, finance setup, post-trip nudges, and “are we over budget so far?”; do NOT use for non-money trip chat.
---

# trip-finance — shared trip expense ledger

**The one rule: you judge, the script computes.** You parse language and images into structured commands; the script owns every number — shares, balances, rounding, settlements. NEVER do ledger arithmetic yourself, never state a balance you didn't just read from the script.

**The DB is the only source of truth — not your conversation memory.** Before claiming anything is set up, logged, or already exists, check (`$TF status`, `$TF expense <id>`). If `$TF status` shows no trip or fails, the ledger does not exist regardless of what earlier chat says — say so and offer to set up.

```bash
TF="bun /app/skills/trip-finance/scripts/trip-finance.ts --db /workspace/agent/trip.db"
$TF help          # full command reference
$TF status        # trip summary
$TF balance       # who owes whom, per currency
```

## Logging an expense

1. Parse: amount, currency (default: trip base currency), payer, what it was, split rule.
2. **Payer ≠ sender.** The payer comes from the message content or image ("Raj paid", a UPI screen's "From" account) — only default to the message sender when nothing else says who paid. Always name the payer in the playback.
3. Resolve names through the roster (`$TF members` — aliases included). Unknown name → ask, don't guess.
4. **Confirm before commit** when anything was inferred (images, ambiguous text, unusual splits): play back amount, payer, split with per-person amounts (get them from a dry look at `$TF members`, or just state the rule), and wait for a yes. Plain, fully-explicit text like "I paid 500 for snacks, split equally" may commit directly.
5. Commit:

```bash
$TF log --desc "Lunch at Souza Lobo" --amount 4500 --currency INR --payer 5 --rule by-family --by 2
# rules: equal-all (default) | by-family | custom via --custom:
#   '{"kind":"exclude","memberIds":[3,4]}'            equal among everyone else
#   '{"kind":"explicit","shares":{"3":"...minor units must sum to total..."}}'
#   '{"kind":"ratio-by-unit","weights":{"f1":60,"f2":40}}'   60/40 between families
#   '{"kind":"ratio-by-member","weights":{"2":1,"6":2}}'
```

`--by` is the member id of whoever sent the message (logged_by). The script replies with the exact per-person shares — echo those to the group as confirmation.

For an itemised bill with an uneven request, use `--items` rather than inventing an adjustment. Amounts are major units, must sum exactly to `--amount`, and `"all"` means active split participants on that expense date.

```bash
$TF log --desc "Dinner" --amount 4500 --currency INR --payer 5 --by 2 --items '[{"label":"Beer","amount":600,"members":[2,5]},{"label":"Food","amount":3900,"members":"all"}]'
```

Read back `$TF expense <id>` before and after an itemised change. Re-supply `--items` when changing its total; the script protects the item-total invariant.

## Images (UPI screenshots, bill photos)

Only act on images when the message @mentions you (or reply-quotes an image with a mention). Read the image, extract: amount, currency, payee/merchant, payer (UPI "From"/"Debited from" account if visible). **A wrong amount is the one unacceptable failure** — if any digit is unclear, ask for the amount instead of guessing. Then run the normal confirm-before-commit playback with `--source upi-image` or `--source bill-image`.

## Edits, voids, repayments, status

```bash
$TF expense 14                       # show before editing
$TF edit 14 --amount 5200 --actor 2  # show before/after, confirm, then run
$TF void 14 --actor 2                # soft delete (history preserved)
$TF settlement --from 5 --to 1 --amount 2000 --currency INR   # "I sent Arjun 2000"
$TF settle                           # minimal who-pays-whom plan
$TF settle --links                   # INR UPI links when a payee opted in
$TF burn                             # deterministic spend pace and budget projection
$TF journal --limit 10               # audit trail of every change
```

Anyone in the group may log/edit/void — every change is journaled with who did it. **Reset is owner-only and needs double confirmation in chat** before `$TF reset --actor <id> --confirm`.

## Trip status (works from any wired chat, incl. Telegram)

On "trip status" / "@trip status", combine both layers and reply with one compact summary:

```bash
$TF status                  # ledger layer: trip config, expense/settlement counts
ncl groups get              # infra layer: your agent group (id auto-filled)
ncl members list            # who is allowlisted
ncl destinations list       # where you can send
ncl sessions list           # active sessions
```

Render as: trip name + status, roster size, expenses (active/voided), settlements, currencies in play, then members and wired chats. If `ncl` is unavailable (cli_scope disabled), report the ledger layer only.

## Multi-currency

## Settling the trip

In `post_trip`, relay the heartbeat’s settle plan and record every reminder. Escalate gently: friendly plan, then direct mentions of people who owe, then suggest settling face-to-face and offer to stop. When all balances clear, celebrate briefly and propose archiving to the owner.

```bash
$TF settle
$TF nudge status
$TF nudge record
```

Do not spam static debt daily: a heartbeat allows a new reminder only when transfer edges change or three days pass.

Offer `set-member <id> --upi <vpa>` once per trip, without pressure; `$TF members` masks the VPA. For “are we over budget so far?”, run `$TF burn` and relay its output exactly—foreign-currency spend is listed but never silently converted.

## Multi-currency

Each expense stays in the currency it was paid in; balances report per currency. Never convert silently. If someone gives an explicit rate ("count USD at 84"): `$TF balance --consolidate USD=84` (the rate is journaled).

## Trip setup / config changes

Roster lives in config tables: `$TF init`, `add-family`, `add-member` (aliases, family, `--excluded` for non-participants like a driver), `set-member` (joins/leaves/exclusions take effect by date). Config changes follow the same propose → confirm loop.

## Help — recite this on "how does finance work"

> I track shared expenses for the trip. Tell me what was paid — "I paid 4500 for lunch, split by families" — or @mention me on a UPI screenshot or bill photo. I'll play back what I understood before saving. Anything can be fixed later ("fix #14 — Raj wasn't in it") and every change is recorded openly. Ask "balance" or "settle up" anytime for who-owes-whom per currency; repayments ("I sent Raj 2000") are tracked too. Each expense keeps the currency it was paid in; I only convert at a rate you give me. All math is done by a tested script, never by me guessing.
