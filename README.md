# NanoClaw: Ops Center & Trip Companion

Run your AI assistants from one dashboard. Plan group trips in the chats you
already use.

This is a fork of [NanoClaw](https://github.com/nanocoai/nanoclaw), with two
main additions: **Ops Center** for operating your agents, and **Trip Companion**
for keeping a group's travel plans, decisions, documents, and shared expenses
together. Agents run in separate containers and keep structured state in SQLite.

## Ops Center

See which agents are running, inspect recent conversations and execution runs,
and check token use, estimated cost, and runtime health. Manage models, skills,
chat connections, and agent lifecycle from the same place.

The dashboard also brings together knowledge stores, documents, and trip status.
It runs independently of the agent host, so it can remain available when the
host needs attention.

[Ops Center quick guide](docs/ops-center-quickstart.md)

## Trip Companion

Give a group trip an assistant in Telegram, WhatsApp, or the local CLI. It keeps
track of who's coming, preferences, itinerary options, group decisions, shared
expenses, and trip documents. Plans and balances live in structured stores, so
they can be read back as the conversation continues.

Create and connect a trip from Ops Center. Ask the assistant to recap the plan,
compare an activity, record an expense, or prepare a trip document. When the
trip is finished, the archive workflow verifies a snapshot before removing the
live trip.

[Trip Companion quick guide](docs/trip-companion-quickstart.md)

## Get started

Clone this repository, then run from its root:

```bash
bash nanoclaw.sh
```

Follow the setup prompts to configure the runtime and pair your first agent.
Then install Ops Center as a background service:

```bash
./ops-center/install.sh
```

Open [Ops Center](http://127.0.0.1:10333). Select **Trip Companion** to create
your first trip. The host uses Node 22 and pnpm; agents use Bun in containers.
See [runtime details](docs/build-and-runtime.md) for the supported environment.

Ops Center binds to loopback. For a remote deployment, use your private
SSH/Tailscale access path. Making the source repository public does not make
your dashboard, chats, credentials, or trip data public.

## Learn more

- [Architecture](docs/architecture.md)
- [Trip setup, operation, and archival](docs/trip-companion-lifecycle.md)
- [Trip Companion skill suite](container/skills/trip-companion-skills/README.md)
- [Security](docs/SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Credits and license

Built on [NanoClaw by nanocoai](https://github.com/nanocoai/nanoclaw).
Original copyright and license notices are preserved. MIT licensed; see
[LICENSE](LICENSE).
