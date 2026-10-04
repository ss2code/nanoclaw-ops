# NanoClaw: Ops Center & Trip Companion

Run your AI assistants from one dashboard. Plan group trips in the chats you
already use.

This is a fork of [NanoClaw](https://github.com/nanocoai/nanoclaw), with two
main additions: **Ops Center** for operating your agents, and **Trip Companion**
for keeping a group's travel plans, decisions, documents, and shared expenses
together. Agents run in separate containers and keep structured state in SQLite.
This repository holds reusable source; each installation creates its own
configuration, credentials, conversations, and trip data.

## Watch the demo

[![Ops Center and Trip Companion demo preview](docs/media/nanoclaw-demo-preview.png)](docs/media/nanoclaw-demo.mp4)

[Play the 30-second demo](docs/media/nanoclaw-demo.mp4) ·
[Read the captions](docs/media/nanoclaw-demo.vtt) ·
[Browse the visual tour](docs/visual-tour.md)

The demo and screenshots use an isolated installation with fictional agents
and trip data. The labeled diagrams explain the product; they are not UI
screenshots.

## Ops Center

Ops Center is the browser dashboard for a NanoClaw installation. Start with
**Overview** to see agent activity, traffic, and items needing attention. Open
**Runs** and **Logs** to understand what happened during a turn. Use **Chat** to
talk to an agent group from the browser, then inspect its model, skills, chat
connections, and lifecycle controls.

![Illustrative map of Ops Center's Overview, Runs and Logs, Chat, and configuration areas](docs/media/ops-center-map.svg)

*Feature map: observe the fleet, investigate a run, talk to an agent, and
adjust its setup.*

This is the actual **Chat** view in the isolated demo. Each row opens a
browser conversation with an agent group; the fictional groups shown here are
Lisbon Trip, Ops Analytics, and Research Scout.

![Ops Center Chat view with three fictional agent groups](docs/media/ops-center-chat.png)

The dashboard also brings together knowledge stores, documents, and trip
status. It runs independently of the agent host, so it can remain available
when the host needs attention. The diagram below shows how a connected chat
becomes a run that Ops Center can help you inspect.

![Diagram showing a message routed through the NanoClaw host and an agent container, then observed in Ops Center](docs/media/ops-center-message-flow.svg)

[Ops Center quick guide](docs/ops-center-quickstart.md) ·
[More screenshots and explanations](docs/visual-tour.md#ops-center)

## Trip Companion

Trip Companion gives one group trip an assistant in Telegram, WhatsApp, or the
local CLI. The group can ask for a recap, compare options, record a decision,
split an expense, or prepare a trip document. Members, plans, decisions,
expenses, and documents live in structured stores, so the assistant can read
them back as the conversation continues.

**Create the trip.** Ops Center guides the chat connection, member setup, and
agent creation. The screenshot shows the beginning of that browser flow with
fictional fixture data.

![Trip Companion setup view in Ops Center](docs/media/trip-companion-setup.png)

**Follow its state.** The resulting status card brings the trip stage, agent
runtime, members, memory, decisions, and chat wires into one view. Lisbon Trip
and its members in this screenshot are fictional.

![Trip Companion status card for a fictional Lisbon trip](docs/media/nanoclaw-demo-preview.png)

![Diagram of a group conversation connected to a Trip Companion agent, structured trip records, and Ops Center](docs/media/trip-companion-flow.svg)

When the trip is finished, the archive workflow verifies a snapshot before
removing the live trip. The diagram shows how conversation, structured records,
and Ops Center fit together.

[Trip Companion quick guide](docs/trip-companion-quickstart.md) ·
[Visual tour](docs/visual-tour.md#trip-companion)

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
