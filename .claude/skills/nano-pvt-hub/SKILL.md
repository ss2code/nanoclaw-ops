---
name: nano-pvt-hub
description: Publish to and browse the NanoClaw private docs hub — a tailnet-only document repository (NanoClaw Docs, Dashboards, Trackers, Agent Docs) served under the Ops Center Docs tab. Use to publish/update/list/sweep hub documents from the host, or to (re)scaffold the hub store. Triggers on "docs hub", "nano-pvt-hub", "publish a dashboard/tracker/doc", "private hub".
---

# nano-pvt-hub — private docs hub (host / clot side)

A single-root document repository browsable over the tailnet from the Ops Center
**Docs** tab (`http://127.0.0.1:10333/hub/`). It holds four surfaces, all under
`data/hub/`:

| Surface | Where | Written by |
|---------|-------|-----------|
| **NanoClaw Docs** | `data/hub/nanoclaw-docs` → symlink to repo `docs/` | nobody — read-only index (don't regenerate docs) |
| **Dashboards** | `data/hub/dashboards/<audience>/<id>/` | agents & host (HTML the agent builds for a user) |
| **Trackers** | `data/hub/trackers/<audience>/<id>/` | agents & host (status page / append-log / table) |
| **Agent Docs** | `data/hub/agent-docs/<audience>/<id>/` | agents & host (generic reference docs) |

The engine is one dependency-free script, `container/skills/nano-pvt-hub/hub.mjs`
(the same file agents run inside containers as `bun /app/skills/nano-pvt-hub/hub.mjs`).
`.claude/skills/nano-pvt-hub/hub.mjs` is a symlink to it — one source of truth.

**Manifests are truth; `catalog.json` is a derived cache** (rebuilt atomically on
every write). Ops Center reads `catalog.json` to render the Docs tab; it never
imports this script.

## Publishing rules (hygiene contract — mirrors hermes-private-hub)

Every published artifact needs a **kind, a title, and a bounded source file**.
**Never publish** credentials, API keys, raw channel identifiers, chat/runtime
DBs, private portfolio data, PII, or raw provider responses. Documents are
**durable by default** (no expiry); pass `--ttl 30d` to make one expire.

## Usage (host)

Always pass `--root data/hub`. Run from the repo root.

```bash
# Publish a dashboard (HTML) or an agent doc (.md/.html/.txt/.json/.csv/.svg)
node container/skills/nano-pvt-hub/hub.mjs publish \
  --kind dashboard --title "Fleet Status" --summary "live fleet view" \
  --source /path/to/report.html --root data/hub

# Update a status page in place — reuse the same --id
node container/skills/nano-pvt-hub/hub.mjs publish \
  --kind tracker --shape status --id fleet-status --title "Fleet Status" \
  --source /path/to/report.html --root data/hub

# Append to a log tracker (auto-creates it on first append)
node container/skills/nano-pvt-hub/hub.mjs append \
  --id deploy-log --title "Deploy Log" --record '{"event":"deploy","ok":true}' --root data/hub

# List / inspect / clean up
node container/skills/nano-pvt-hub/hub.mjs list --root data/hub
node container/skills/nano-pvt-hub/hub.mjs get --kind dashboard --audience shared --id fleet-status --root data/hub
node container/skills/nano-pvt-hub/hub.mjs sweep --root data/hub    # remove expired
node container/skills/nano-pvt-hub/hub.mjs help
```

`publish` also accepts `--audience <name>` (default `shared`), `--series`,
`--ttl none|30d`. Trackers accept `--shape status|log|table`.

## Scaffold / apply (idempotent — safe to re-run)

`data/hub/` is runtime state (gitignored), so recreate it on any fresh checkout.
This creates the store, the four surfaces, the read-only docs symlink, and the
initial catalog:

```bash
mkdir -p data/hub/dashboards data/hub/trackers data/hub/agent-docs
printf 'NanoClaw nano-pvt-hub artifact store\n' > data/hub/.hub-store
# nanoclaw-docs points at the repo docs/ so all four surfaces sit as siblings
[ -e data/hub/nanoclaw-docs ] || ln -s ../../docs data/hub/nanoclaw-docs
node container/skills/nano-pvt-hub/hub.mjs rebuild --root data/hub
```

Then restart Ops Center so it serves the new tab (label is discovered from the
running service, so this works on any install):

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/$(launchctl list | grep -o 'com.nanoclaw.opscenter-[a-z0-9]*' | head -1)
# Linux (systemd): the unit is nanoclaw-opscenter-<slug> — find it with:
#   systemctl --user list-units 'nanoclaw-opscenter-*' --no-legend | awk '{print $1}' | xargs -r systemctl --user restart
```

Browse it at `http://127.0.0.1:10333/hub/`. For off-machine access over the
tailnet, expose the whole Ops Center once (Funnel stays OFF):

```bash
tailscale serve --bg --https=443 http://127.0.0.1:10333
tailscale serve status     # expect :443 -> 127.0.0.1:10333
tailscale funnel status    # must be empty
```

Then browse `https://<magicdns-name>/hub/` from any tailnet device.

## Notes

- **Agents publish the same way**, from inside their container, using
  `bun /app/skills/nano-pvt-hub/hub.mjs ... --root /workspace/hub`. See the
  container skill of the same name.
- **Retrieval/indexing for agents** is `hub.mjs index` (JSON: catalog + docs
  file list) — a filesystem read, no HTTP needed.
- Removing the feature: see `REMOVE.md`.
