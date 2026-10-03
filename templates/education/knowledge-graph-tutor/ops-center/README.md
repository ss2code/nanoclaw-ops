# Tutor Foundry

Tutor Foundry is the application-specific console for NanoClaw's
knowledge-graph tutor. Its primary surface is the **Tutor Foundry** tab in Ops
Center, where Configuration, Status, and workflow Help views work through the
existing trusted-host/Tailscale access path. The UI remains a thin adapter over
the existing lifecycle and Telegram pairing authorities.

## Lifecycle order

The intended order is:

1. Configure the Telegram bot through NanoClaw's normal channel setup.
2. Define and save the class draft in Tutor Foundry.
3. Pair the tutor control group and each private student group. Pairing is a
   one-time identity proof and does not require a container.
4. Create the class wiring. This creates the agent group, tutor application,
   app databases, memberships, and shared-mode room wires.
5. Send the first message in each room. NanoClaw creates a separate session
   container for that room on demand; there is no single permanent class
   container to create manually.

The pairing code is not the Telegram bot token and is not a long-lived runtime
credential. The bot token stays in NanoClaw's channel configuration, while the
class wiring stores the verified Telegram user/group routes needed for routing.

## Open it

Start Ops Center normally, open its URL locally or through the configured remote
machine address, and select **Tutor Foundry** in the left navigation. No second
web process or port is required. The local path is:

```text
http://127.0.0.1:10333/tutor-foundry
```

The original loopback-only launcher remains available as a development fallback:

```bash
templates/education/knowledge-graph-tutor/ops-center/launch.sh start
templates/education/knowledge-graph-tutor/ops-center/launch.sh status
templates/education/knowledge-graph-tutor/ops-center/launch.sh stop
```

Its default URL is `http://127.0.0.1:10335`. Override it with
`TUTOR_CONSOLE_PORT`. The launcher explicitly selects Node 22.19+ from the Node
22 line (rather than accepting a newer ABI) and opens the page on macOS. The
server binds only to loopback.

Stopping Tutor Foundry does not stop any classes. A class's Status card offers:

- **Pause / shut down** — persistently suppresses message and schedule wakes and
  stops its containers. Resume is reversible.
- **Restart containers** — retires current containers; they return on demand.
- **Remove registration** — removes central NanoClaw records but retains the
  group workspace for recovery.
- **Permanently purge** — removes central state, the exact group workspace, and
  its exact session directory. It requires typing the application ID.

## Data and security

- Bot tokens are written through NanoClaw's existing `set-env` setup step and
  never returned to the browser or stored in console records.
- Phone and roll numbers are optional operator metadata. They are stored only in
  `data/knowledge-graph-tutor-console/instances/` with mode `0600`; runtime tutor
  configs do not contain them.
- Telegram user and group IDs come from the existing one-time pairing primitive.
- In Ops Center, mutating calls use the existing Ops action token and
  same-origin/trusted-host checks. The server remains loopback-bound and remote
  access continues through Ops Center's configured access-controlled proxy.
- In standalone mode, mutations use a separate per-process action token and
  loopback-only origin/Host checks; CSP and frame denial remain enabled.
- Runtime configs live in `data/knowledge-graph-tutor-console/configs/`. Nothing
  under `data/` is committed.

## Modular boundary

- `domain.ts` maps UI parameters to the lifecycle's canonical config and runs
  the same parser before mutation.
- `service.ts` adapts lifecycle, pairing, and application-specific status.
- `../host/status.ts` is the canonical application-status reader: it reads class
  roster state and course graph revisions from the Tutor Foundry databases
  directly, without a child CLI process or infrastructure fallback values.
- `server.ts` owns the optional standalone HTTP/security boundary through the
  `TutorConsoleApi` interface.
- `ops-center.ts` supplies the embedded page and namespaced API dispatcher.
- `public/` is framework-free HTML/CSS/JS and knows nothing about SQLite or CLI
  commands.

`../ops-center.json` is the only registration point. NanoClaw discovers the
contribution and supplies the common Ops Center shell, authentication boundary,
navigation slot, and asset/API hosting; no Tutor Foundry import or route lives
in the dashboard core.

## Verification

```bash
pnpm exec tsc -p templates/education/knowledge-graph-tutor/ops-center/tsconfig.json --noEmit
pnpm exec tsc -p ops-center/tsconfig.json --noEmit
pnpm exec vitest run scripts/knowledge-graph-tutor-console.test.ts scripts/knowledge-graph-tutor-status.test.ts ops-center/ops-center.test.ts
```

The test suite covers ID/config derivation, route/account collision rejection,
phone-number separation, private record permissions, both page tabs, standalone
guards, Ops Center route dispatch, navigation, and action-token enforcement.
