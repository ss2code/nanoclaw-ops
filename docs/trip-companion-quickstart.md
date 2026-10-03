# Trip Companion in one minute

Trip Companion is a shared travel assistant. It remembers the group's plan,
records decisions, tracks expenses, and prepares trip documents while the group
talks in Telegram, WhatsApp, or the local CLI.

## Create your first trip

1. Open Ops Center and select **Trip Companion**.
2. Enter a trip name and choose a model.
3. Follow **Start Telegram setup** or **Start WhatsApp setup**, then connect a
   new group for the trip. The page guides the external pairing steps.
4. Add each participant and choose **Instantiate trip agent**.
5. Check the trip's status card for the intended chat connection and members.

The external platform still requires your participation: Telegram needs a bot
and group; WhatsApp needs approval on the linked phone. Do not put the WhatsApp
assistant into an existing active group for initial onboarding.

## Try these requests

Mention the assistant using your chat's configured trigger, then ask:

```text
Help us set up a three-day trip to Lisbon.
Recap what we've decided and what is still open.
Compare a walking tour with a day at the beach.
Alex paid €60 for dinner. Split it equally between Alex, Sam, and Taylor.
Prepare a trip document from the current plan.
```

These are illustrative requests with fictional names. The assistant translates
intent into the trip tools; those tools own the structured records, itinerary
checks, expense calculations, and document versions.

## Finish the trip

Follow the [lifecycle runbook](trip-companion-lifecycle.md) to archive a completed
trip. The archive workflow creates and verifies a snapshot before purging the
live workspace and trip-scoped host records. Automated restoration of that
final archive is not currently provided.

Personal trip data stays under your installation's `groups/` and `data/`
directories. The source repository contains the reusable tools and examples.
