---
name: nano-pvt-hub
description: Publish documents to, and look documents up in, the shared NanoClaw docs hub at /workspace/hub — dashboards you build for the user, trackers you maintain (status pages, logs, tables), and reference docs you keep for yourself. Also indexes the project's own documentation. Use whenever you produce a document the user should be able to open later, when you need to check what NanoClaw docs or prior artifacts already exist, or when asked to "publish", "put this in the hub", or "make a dashboard".
---

# nano-pvt-hub — the shared document hub

The hub is a document repository mounted at `/workspace/hub`. Anything you
publish there is browsable by the user in the Ops Center **Docs** tab over their
private network. It is shared across all agent groups — treat it as a common
library, not your private scratch space (that's `/workspace/agent/`).

```bash
HUB="bun /app/skills/nano-pvt-hub/hub.mjs"
```

Every command needs `--root /workspace/hub`.

## What goes where

| Surface | Use it for |
|---------|-----------|
| **Dashboards** (`--kind dashboard`) | A page you built *for the user* — status views, summaries, reports they'll open. |
| **Trackers** (`--kind tracker`) | Something you keep *up to date over time*. Three shapes — see below. |
| **Agent Docs** (`--kind agent-doc`) | Reference *you* want to re-read later — runbooks, notes, how a system works. |
| **NanoClaw Docs** (read-only) | The project's own documentation. You can read and index it; you cannot publish into it. |

Ordinary working files, drafts, and per-turn notes stay in `/workspace/agent/`.
Publish to the hub when the document is finished and worth keeping.

## Before you publish — the hygiene contract

The hub is served over the user's private network and is shared between groups.

- **Never publish** credentials, API keys, tokens, raw channel identifiers,
  chat or runtime databases, personal identifiers, ticket/booking numbers, or
  raw provider API responses.
- Publish a **finished document**, not a dump. Give it a real title and a
  one-line summary.
- Prefer self-contained styled HTML for anything the user reads (same rule as
  other user-facing documents). Markdown is fine for agent docs.
- Documents are **durable by default**. Only pass `--ttl` if the thing genuinely
  expires (e.g. `--ttl 30d` for a time-boxed report).

## Publish a dashboard or an agent doc

Write the file first, then publish it. Source may be `.html` `.md` `.txt`
`.json` `.csv` `.svg` (max 16 MiB).

```bash
bun /app/skills/nano-pvt-hub/hub.mjs publish \
  --kind dashboard --title "Weekly Spend" --summary "Spend by category, last 7 days" \
  --source /workspace/agent/spend.html --root /workspace/hub
```

The command prints JSON including `url` — that is the path the user opens in the
Docs tab. Include it when you tell them the document is ready.

## Trackers — three shapes

**`status`** — one page that always shows the latest state. Re-publish with the
**same `--id`** to replace it in place (history is not kept):

```bash
bun /app/skills/nano-pvt-hub/hub.mjs publish \
  --kind tracker --shape status --id fleet-health --title "Fleet Health" \
  --source /workspace/agent/fleet.html --root /workspace/hub
```

**`log`** — append-only history. Creates the tracker on first append; each
record is one small JSON object (or plain text):

```bash
bun /app/skills/nano-pvt-hub/hub.mjs append \
  --id deploy-log --title "Deploy Log" \
  --record '{"event":"deploy","service":"api","ok":true}' --root /workspace/hub
```

**`table`** — rows you revise. Publish a `.json` or `.csv` source with
`--shape table` and re-publish with the same `--id` to update it. To refresh
just the data behind an existing page, use `put-data`:

```bash
bun /app/skills/nano-pvt-hub/hub.mjs put-data \
  --kind tracker --audience shared --id watchlist --name rows \
  --source /workspace/agent/rows.json --root /workspace/hub
```

## Look things up (do this before writing a new doc)

`index` returns JSON with everything in the hub — published artifacts plus the
list of NanoClaw doc files. It's a filesystem read; no network involved.

```bash
bun /app/skills/nano-pvt-hub/hub.mjs index --root /workspace/hub
bun /app/skills/nano-pvt-hub/hub.mjs list --kind dashboard --root /workspace/hub
```

To read a NanoClaw doc, just read the file:
`/workspace/hub/nanoclaw-docs/<path>` (e.g. `architecture.md`). Check here
before answering questions about how NanoClaw works, and before writing a doc
that may already exist.

Full flag reference: `bun /app/skills/nano-pvt-hub/hub.mjs help`.

## Notes

- `--audience` defaults to `shared` (visible to everyone). Pass your group's
  name to keep a document in its own namespace.
- Publishing the same content twice without `--id` is deduplicated, so retries
  are safe.
- If a command fails with `invalid store marker`, the hub isn't scaffolded on
  the host — tell the user to run the `nano-pvt-hub` skill's scaffold step
  rather than trying to repair `/workspace/hub` yourself.
