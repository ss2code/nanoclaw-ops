# Trip Companion lifecycle runbook

This is the operator runbook for creating, running, archiving, reopening, and
finally deleting a Trip Companion trip.

The important distinction is:

| Layer | What it owns |
| --- | --- |
| Trip Companion | Trip identity, planning, finance, documents, memories, and domain lifecycle |
| NanoClaw host | Agent group, chat wires, members, destinations, sessions, containers, and host wake policy |
| Archive | A verified retention snapshot containing the trip data and trip-scoped host records |

Use the Ops Center **Trip Companion** tab for provisioning, channel onboarding,
wiring, status, and cleanup. Use `/archive-trip` when the trip is finished and
the archive should become the only retained copy. The archive command performs
the final purge; do not run a second delete step afterward.

## 1. Before creating a trip

Before opening the Trip Companion tab:

1. The NanoClaw host is configured and running. The browser setup can install
   the Telegram or WhatsApp adapter and restart the host, but it cannot create
   the external account on your behalf.
2. An owner/admin identity exists. The normal first-agent bootstrap is still
   required for a new installation.
3. You have chosen a stable trip name. The browser derives the agent-group id
   and workspace folder; do not use a temporary name if the trip will be used in production.
4. You have the phone or Telegram account that will perform the external
   pairing action.

### External channel prerequisites

The Trip Companion tab is now the platform onboarding flow. The external
service still requires a short action from you, because only you can create the
bot/group or approve a linked device. The browser starts the NanoClaw-side
work, displays exactly what to do on the other side, polls for completion, and
inserts the resulting chat and member identities into the draft.

#### Telegram

1. In Telegram, open `@BotFather`, send `/newbot`, complete the prompts, and
   copy the token for the specific bot you intend to include in this trip’s
   group. There is one bot token, not a token per user. The bot name and
   username are useful for operator clarity, but are not separate credentials
   and do not need to be typed into the form.
2. In Trip Companion, choose **Telegram**, paste the BotFather token, and click
   **Start Telegram setup**. The browser installs/configures the adapter if
   needed, stores the token on the host, restarts NanoClaw, and creates the
   one-time pairing code.
3. In the Telegram app, create a new private group for this trip, add the bot
   and the first participant, and keep this browser page open. Do not reuse a
   group already wired to another agent.
4. For group chats, decide whether the bot should see ordinary messages. In
   `@BotFather`, use `/mybots -> your bot -> Bot Settings -> Group Privacy` and
   turn privacy off when that is required. With privacy on, use a bot mention
   when sending the pairing code.
5. Send the exact four-digit code shown by the browser in that Telegram group.
   With privacy on, send `@botname 1234`; with privacy off, send `1234`.
   The browser detects the consumed code and fills the canonical group wire
   and first paired user. Have additional participants send one message, then
   click **Refresh discovered chats** and add their identities from the page.

#### WhatsApp

1. In Trip Companion, choose **WhatsApp**, choose QR or phone pairing, and
   click **Start WhatsApp setup**. The browser installs the adapter if needed,
   starts linked-device authentication, and displays the QR/pairing code.
2. On the phone whose number will represent the assistant, use
   `WhatsApp -> Settings -> Linked Devices -> Link a Device`. WhatsApp has no
   bot/API token in this adapter; the browser saves the linked-device
   credentials and restarts NanoClaw automatically.
3. Create a brand-new WhatsApp group for this trip with the linked assistant
   number and the first participant. Do not reuse an existing or active group.
   Send one message so NanoClaw discovers it.
4. Click **Refresh discovered chats** and select the exact new group. The page
   inserts the native group JID as the wire platform ID: `<digits>@g.us`.
   Add each discovered participant; member identities are separately
   allowlisted, for example `whatsapp:<phone>@s.whatsapp.net`.

For Telegram and WhatsApp groups, select `@mention` as the engage mode and
mention the platform's linked bot/assistant. A `pattern` wire is primarily for
the CLI smoke-test transport.

The generated trip config is a host-side provisioning input. Real config files under
`trips/` are ignored by Git; only `trips/example.trip.json` is tracked. This
prevents chat ids and member identities from being accidentally committed.

## 2. Create the trip in Ops Center

Open the **Trip Companion** tab and complete the form:

```json
{
  "id": "ag-goa-2026",
  "name": "Goa 2026",
  "folder": "goa-2026",
  "model": "sonnet",
  "maxMessagesPerPrompt": 30,
  "members": [
    { "user": "telegram:5550001111", "displayName": "Alex" }
  ],
  "wires": [
    {
      "channel": "telegram",
      "platformId": "<telegram-group-chat-id>",
      "engageMode": "mention",
      "ignoredMessagePolicy": "accumulate"
    },
    {
      "channel": "cli",
      "platformId": "goa-2026-dev",
      "engageMode": "pattern",
      "engagePattern": "@trip"
    }
  ]
}
```

The JSON above is only a vocabulary reference; do not create a file or type a
command. Enter the trip name and model in the form, use **Start Telegram setup**
or **Start WhatsApp setup** for a live chat, and let the browser fill the exact
wire/member identities. Add any remaining participants from **Refresh
discovered chats**, then choose **Save draft** or **Instantiate trip agent**.

Instantiation is idempotent. The browser invokes the existing validated Trip
Companion workflow, which creates or reconciles the agent group, workspace,
container configuration, messaging groups, wirings, destinations, and member
allowlist.

## 3. Review the result in Ops Center

The status card is the first acceptance check:

- every intended wire is present;
- every wire has a destination and does not say `NO DESTINATION`;
- the expected members are present;
- the group folder matches the chosen folder; and
- the model and message limit are correct; and
- the host/runtime card shows the expected active sessions, pending work,
  memory grounding, domain workflows, and recent operational messages.

### Telegram

The browser pairing result is already canonicalized as
`telegram:<chat-id>`. If the status card shows a missing destination or a
sender warning, open the wire/member sections in the draft, reconnect the
exact Telegram group, and instantiate again.

### WhatsApp

WhatsApp setup has an important safety rule: create a brand-new group for this
trip with the bot and the first member. Never add the bot to an existing or
active group.

The browser inserts the newest selected group’s native JID as `platformId` and
the discovered participant identities into the draft. Verify the assistant
replies for each new member before adding the next one. If the owner receives
an unknown-sender approval prompt for this setup, stop: it usually means the
assistant was put into an existing group. Create a fresh group instead of
approving through that path.

## 4. Verify the first conversation

After provisioning, send `@trip set up the trip` in the intended chat. The
agent should establish or reconcile the trip ledger. Then use:

```text
@trip status
```

The agent's status response is the chat-level check for the trip ledger and
runtime grounding. The Trip Companion status card is the host-level check; it
shows lifecycle, sessions, wires, members, memory grounding, workflows, and
recent operational messages. For later planning turns, the agent should ground
itself in `trip-core recap` before changing trip state. The structured SQLite
stores, not chat prose, are the source of truth.

## 5. Run the domain lifecycle

The normal domain lifecycle is:

```text
planning -> plan_ready -> start_trip -> on_trip -> trip_complete -> post_trip -> archived
```

An unstarted trip may instead be cancelled and then archived. The trip agent
proposes transitions; the owner confirms important transitions. The underlying
commands are:

```bash
TC="bun /app/skills/trip-core/scripts/trip-core.ts --db /workspace/agent/trip.db"
$TC recap
$TC status
$TC stage show
$TC stage propose --to plan_ready --by <member-id>
$TC stage confirm --to plan_ready --by <owner-id>
```

The exact transition command is normally run by the container agent using its
mounted `trip.db`. Do not edit `trip.db` by hand. Keep finance settlement and
post-trip documents in their domain stores before confirming `archived`.

If the model or message limit changes, reconcile the config and restart the
trip group so the running container picks up the change:

```bash
pnpm exec tsx scripts/trip-admin.ts apply trips/goa-2026.trip.json
pnpm exec tsx src/cli/client.ts groups restart --id ag-goa-2026
```

## 6. Archive and purge a completed trip (recommended teardown)

Archiving is the normal final end state when the trip should remain available
for history through its archive. It is destructive to the live NanoClaw copy,
but the command refuses to proceed until the archive has been created and
verified.

First, move the domain trip to `archived` (or `cancelled`) and finish any
pending work. Then run the read-only preflight:

```bash
pnpm exec tsx .claude/skills/archive-trip/scripts/archive-trip.ts preview \
  --id ag-goa-2026 --json
```

Proceed only when:

- the trip-domain stage is `archived` or `cancelled`;
- there are no pending messages or in-flight processing claims; and
- any live containers are understood and can be stopped.

Create the archive with explicit confirmation:

```bash
pnpm exec tsx .claude/skills/archive-trip/scripts/archive-trip.ts archive \
  --id ag-goa-2026 --yes
```

The archive operation:

1. sets the host lifecycle to `paused`, so scheduled and automatic wakes stop;
2. waits for live containers to stop;
3. creates `data/trip-archives/<folder>-<UTC timestamp>.tar.gz`;
4. includes the group workspace, session databases, `manifest.json`, and a
   trip-scoped `host-records.json` export;
5. verifies required archive entries and computes SHA-256;
6. writes a matching `.manifest.json` sidecar; and
7. removes the central agent-group cascade, `groups/<folder>/`, and
   `data/v2-sessions/<agent-group-id>/`, then verifies that those records and
   paths are gone.

`node_modules` is excluded by default. The workspace lockfiles and source data
are retained; use `--include-node-modules` only if an offline copy of the
runtime dependencies is a specific requirement.

Verify the result:

```bash
pnpm exec tsx scripts/trip-admin.ts status ag-goa-2026
ls -lh data/trip-archives/
```

Copy the `.tar.gz` and its `.manifest.json` to independent storage and retain
the SHA-256. The live group and session paths should already be gone. If the
command fails before purge, the source is left intact; if it reports success,
the archive is the retained copy.

## 7. Restore an archived trip

The final archive command does not leave a live group to resume. The archive is
the recovery artifact. A future restore workflow would need to restore the
workspace/session files and reapply the `host-records.json` data; this is not
currently automated by `/archive-trip`.

## 8. Do not run a second delete step

`/archive-trip` now performs the central cascade and the exact on-disk purge.
`trip-admin delete` remains a lower-level operation for other group-retirement
cases, but it intentionally does not remove `groups/<folder>/` or
`data/v2-sessions/<agent-group-id>/`. Do not use it after a successful archive.

## 9. Where the data lives and what to back up

For a trip with group id `ag-goa-2026` and folder `goa-2026`:

| Path | Contents | Included in the trip archive? |
| --- | --- | --- |
| `groups/goa-2026/trip.db` | Authoritative structured trip state: identity, lifecycle, planning, finance, decisions, and documents metadata | Yes |
| `groups/goa-2026/memory.db` | Curated long-term memory | Yes |
| `groups/goa-2026/` | Trip documents, assets, exports, and the group workspace | Yes, except `node_modules/` by default |
| `data/v2-sessions/ag-goa-2026/` | Inbound/outbound session databases and conversation/session state | Yes |
| `data/v2.db` | Host-wide users, roles, agent groups, wires, destinations, lifecycle rows, and routing metadata for all groups | No; the archive contains the trip-scoped export in `host-records.json` |
| `data/trip-archives/` | Generated `.tar.gz` archives and manifest sidecars | This is where the backup is written |
| `logs/` | Host logs, including channel pairing/debug history | No |

For ordinary trip retention, keep the generated archive and manifest off the
machine. For full NanoClaw disaster recovery, use a separate host backup of
the relevant `data/` state (including `data/v2.db`) and logs, preferably with
the host stopped or using a filesystem/database snapshot. A trip archive is
self-contained for this trip's workspace, sessions, and host metadata, but is
not a backup of every other host group.

## 10. Quick checklist

### Setup

- [ ] Channel credentials and owner identity are ready.
- [ ] Config has stable id/folder, members, and wires.
- [ ] `trip-admin apply` completed.
- [ ] `trip-admin status` shows destinations and expected members.
- [ ] Telegram/WhatsApp pairing was done with the correct group procedure.
- [ ] `@trip set up the trip` and `@trip status` work.

### Archive

- [ ] Domain stage is `archived` or `cancelled`.
- [ ] Finance/documents/post-trip work is complete.
- [ ] Archive preview has no pending or in-flight work.
- [ ] Archive created, required entries verified, and manifest SHA-256 recorded.
- [ ] Central group records and live group/session paths were purged.
- [ ] Archive copied to independent storage.

Related references: [`/new-trip`](../.claude/skills/new-trip/SKILL.md),
[`/archive-trip`](../.claude/skills/archive-trip/SKILL.md),
[`trips/example.trip.json`](../trips/example.trip.json), and the
[Trip Companion skill suite](../container/skills/trip-companion-skills/README.md).
