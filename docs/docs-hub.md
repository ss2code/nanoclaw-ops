# nano-pvt-hub — the Ops Center docs hub

The Ops Center **Docs** tab (`/hub`) is a document repository: NanoClaw's own
documentation plus the dashboards, trackers, and reference docs agents publish.
It is browsable across the tailnet and indexable by agents.

It deliberately reuses the Ops Center process — a separate launchd service that
was already running and already served static docs — so the hub adds **no new
daemon, no new port, and no new polling loop**.

## The four surfaces

All four sit as siblings under one root, `data/hub/`:

```
data/hub/
  .hub-store                       marker — destructive ops refuse without it
  catalog.json                     derived index (rebuilt from manifests)
  nanoclaw-docs -> ../../docs      NanoClaw Docs (read-only symlink)
  dashboards/<audience>/<id>/      Dashboards
  trackers/<audience>/<id>/        Trackers
  agent-docs/<audience>/<id>/      Agent Docs
```

| Surface | What it is | Written by |
|---------|-----------|-----------|
| **NanoClaw Docs** | The repo's `docs/` folder, served read-only through a symlink. Not copied and not regenerated — one source of truth. | nobody |
| **Dashboards** | Pages agents build *for the user*. | agents + host |
| **Trackers** | Things kept current over time: `status` (replace in place), `log` (append-only NDJSON), `table` (revisable rows). | agents + host |
| **Agent Docs** | Reference material agents keep for themselves. | agents + host |

`data/hub/` is gitignored runtime state, and is covered by the existing nightly
`data/` backup.

## Storage model

Mirrors a private docs hub: **per-artifact `manifest.json` files are the
source of truth; `catalog.json` is a derived cache.**

- Publishing stages into `.tmp-<id>-<rand>/` and then **atomically renames** it
  into place, so a partially written artifact is never visible to a reader.
- `catalog.json` is rewritten tmp-then-rename, and is a pure function of the
  manifests — so the host and any number of containers can write concurrently
  and converge **without a lock**.
- Documents are **durable by default** (`expiresAt: null`). `--ttl 30d` opts a
  document into expiry; `sweep` only deletes artifacts with a past `expiresAt`.

## Publishing and retrieval — one script, two runtimes

`container/skills/nano-pvt-hub/hub.mjs` is the only implementation. It uses
nothing but `node:` built-ins, so **both** runtimes execute it independently
against a `--root`:

| Caller | Command |
|--------|---------|
| Host (Node) | `node container/skills/nano-pvt-hub/hub.mjs <cmd> --root data/hub` |
| Container (Bun) | `bun /app/skills/nano-pvt-hub/hub.mjs <cmd> --root /workspace/hub` |

This does not violate the host/container no-shared-modules rule: nothing is
imported across the boundary: each side runs the file, and they communicate only
through the filesystem. `.claude/skills/nano-pvt-hub/hub.mjs` is a symlink to
the canonical copy, so there is no second copy to drift.

Commands: `publish`, `put-data`, `append`, `list`, `catalog`, `get`, `index`,
`rebuild`, `sweep` (`help` for flags).

**Agents retrieve by reading the mount, never over HTTP** — `hub.mjs index`
returns the catalog plus the NanoClaw docs file list as JSON, and docs are read
directly from `/workspace/hub/nanoclaw-docs/`. Container egress restrictions
therefore never affect hub access; `:10333/hub/` is a human convenience.

## How containers get it

`buildHubMount()` in `src/container-runner.ts` adds `data/hub → /workspace/hub`
alongside the read-only `/workspace/global`. Access is controlled per group by
`hardening.hubAccess`: `read-write`, `read-only`, or `none`. The default is
`read-write` for backward compatibility, so ordinary and newly created groups
keep the existing behavior without extra wiring. Untrusted workers can inspect
the same catalog with `read-only` while handing publication artifacts to a
trusted agent.

The skill *code* is available to all containers regardless, because
`container/skills/` is mounted read-only at `/app/skills` for every container.
A group's `container.json` `skills` list only controls whether the skill is
*advertised* in `~/.claude/skills`; groups set to `"all"` pick it up
automatically. Selection is re-synced on **every** container spawn, so adding it
to a group's list takes effect on that group's next natural wake — no forced
restart is needed.

## Serving and its guards

`serveHubFile` in `ops-center/server.ts` serves the store read-only, with
`resolveHubPath` as the security boundary. Because groups with `read-write`
access can create store entries and the result is served over the tailnet, that
function is what stands between an agent-created symlink and a file the tailnet
can read:

- Resolution is checked against a **realpath allowlist** — the hub dir plus the
  docs dirs. This is what lets the `nanoclaw-docs` symlink (which by design
  resolves outside the hub) work, while any other escape symlink — `→ /etc/passwd`,
  `→ ~/.ssh`, `→ ../v2.db` — resolves outside every allowed root and 404s.
- `..` traversal is rejected before resolution.
- `docs/local/**` is part of the NanoClaw Docs surface: it is listed and served
  through the same read-only `nanoclaw-docs` path for loopback and configured
  trusted-host views (including Tailscale). The folder is grouped/collapsed in
  the UI so the main Docs section stays compact.
- Responses carry `x-content-type-options: nosniff` and
  `x-robots-tag: noindex, nofollow`.

Both directions are pinned by `ops-center/hub.test.ts`; store semantics are
pinned by `container/skills/nano-pvt-hub/test/hub.test.ts` (Bun).

`/docs` and `/docs/*` 302 to `/hub/` and `/hub/nanoclaw-docs/*` so old bookmarks
keep working.

## Remote access

Ops Center still binds `127.0.0.1` only. Tailnet access is via Tailscale Serve,
which proxies from the tailnet into that loopback port:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:10333
tailscale serve status     # :443 -> 127.0.0.1:10333
tailscale funnel status    # must stay tailnet-only, never public
```

The Ops Center's `OneCLI ↗` header link follows the current browser host and
protocol. For it to work from another tailnet device, expose OneCLI through a
second private Tailscale Serve HTTPS port on the runtime machine:

```bash
tailscale serve --bg --https=10254 http://127.0.0.1:10254
tailscale serve status     # should show both 443 → Ops Center and 10254 → OneCLI
```

Local `http://127.0.0.1` access continues to use the local OneCLI gateway; the
same link becomes `https://<machine>.ts.net:10254/overview` for a Tailscale
Serve session. Keep this as Serve, not Funnel, so the gateway remains tailnet-only.

**This alone is not enough** — Ops Center also checks the `Host` header, which
is its defense against DNS rebinding (a hostile page resolving its own domain to
`127.0.0.1` and driving the admin surface from your browser). A proxied request
arrives with the tailnet hostname, so it is rejected with `403` until that name
is explicitly trusted in `ops-center/config.json`:

```json
{ "trustedHosts": ["ops.example.test"] }
```

`trustedHosts` is empty by default, so an install that does not opt in stays
loopback-only. Entries are matched as **exact hostnames, never wildcards** —
each one is a name an attacker could try to resolve to `127.0.0.1`. The same
list is consulted for the `Origin` check that, together with the action token,
guards mutating `POST /api/*` calls, so trusted front-ends get working controls
rather than a half-broken read-only UI. `hostAllowed` / `originAllowed` in
`ops-center/server.ts`; pinned by `ops-center/hub.test.ts`.

**This exposes the whole Ops Center, not just `/hub`.** Every tailnet peer can
read all its pages — Runs transcripts, Chat, Knowledge, System. Mutating
`POST /api/*` calls remain protected by the action token and a localhost origin
check, but reads are open to the tailnet. Restrict who can reach it with
tailnet ACLs, or expose only the hub with
`tailscale serve --bg --https=443 --set-path /hub http://127.0.0.1:10333/hub`.

## Publishing hygiene

Inherited from the private-hub contract, and repeated in both skill files: never
publish credentials, API keys, tokens, raw channel identifiers, chat/runtime
databases, personal identifiers, ticket/booking numbers, or raw provider
responses. Publish finished documents with a real title and summary.
