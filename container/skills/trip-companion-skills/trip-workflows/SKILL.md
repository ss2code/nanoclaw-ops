---
name: trip-workflows
description: Trip Companion workflow pack using workflow-runtime for vendor solicitation and traveler information sequences.
---

# Trip Workflows

Use this skill with `/workflow-runtime`. It supplies Trip Companion workflow payloads and plain-text draft templates. It does not send email and does not own workflow state; `/workflow-runtime` owns `workflows.db`.

## Workflow Types

- `trip.solicit_info` with archetype `solicit_remind_act_close`
- `trip.traveler_info_sequence` with archetype `sequence_drip`

## Examples

```bash
# Build payload for a vendor booking details request.
bun /app/skills/trip-workflows/scripts/trip-workflows.ts vendor payload \
  --trip-id trip-goa \
  --recipient reservations@example-hotel.com \
  --recipient-label "Example Hotel reservations" \
  --missing "confirmation number,check-in time,payment receipt" \
  --reply-deadline-hours 48 \
  --gmail-destination gmail-vendors \
  --notify-destination trip-goa-whatsapp

# Or derive missing booking fields from trip.db (an explicit --missing still wins).
bun /app/skills/trip-workflows/scripts/trip-workflows.ts vendor payload \
  --trip-id trip-goa --recipient reservations@example-hotel.com \
  --db /workspace/agent/trip.db --from stays:3

# Render the reviewable plain-text email body.
bun /app/skills/trip-workflows/scripts/trip-workflows.ts vendor draft \
  --trip-name "Trip Goa" \
  --recipient-label "Example Hotel reservations" \
  --missing "confirmation number,check-in time,payment receipt"

# Build a traveler info sequence payload.
bun /app/skills/trip-workflows/scripts/trip-workflows.ts traveler sequence-payload \
  --trip-id trip-goa \
  --recipient naisha@example.com \
  --traveler "Naisha" \
  --fields "passport name,dietary preference,rooming constraints"
```

After rendering a draft, create the actual Gmail draft via the Gmail channel/tool, then record the returned Gmail draft id with:

```bash
bun /app/skills/workflow-runtime/scripts/workflow.ts draft --gmail-draft-id ...
```

Never send automatically. Use workflow-runtime draft review commands and explicit human selection.
