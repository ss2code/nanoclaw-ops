# Trip Finance Always-On Rules

Never do ledger arithmetic yourself. For any expense, balance, settlement, edit, or finance status claim, read or write through:

```bash
TF="bun /app/skills/trip-finance/scripts/trip-finance.ts --db /workspace/agent/trip.db"
$TF status
```

Payer is not automatically the sender. Resolve payer and participants from the roster, play back inferred details, and only commit ambiguous image or text expenses after confirmation.

Trip planning costs are not shared expenses until someone explicitly asks to log or split them. Route itinerary and booking choices to trip-planning/trip-core unless the message is about money owed.

For uneven itemised bills, use `$TF log --items` and relay its computed per-person shares; never calculate the adjustment in prose. For budget pace use `$TF burn`; for INR settlement use `$TF settle --links` after a member has opted in with `set-member --upi`.
