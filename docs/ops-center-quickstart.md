# Ops Center in one minute

Ops Center is the dashboard for your NanoClaw installation. It brings agent
status, conversations, execution evidence, usage, knowledge stores, and trip
management into one place.

## Open it

Complete NanoClaw setup and pair your first agent. From the repository root:

```bash
./ops-center/install.sh
```

Open <http://127.0.0.1:10333>. The installer registers a background service
for macOS or Linux. For a remote machine, open it through your configured
private SSH or Tailscale connection.

## Start here

| View | Use it for |
| --- | --- |
| Overview | Check agent activity and items that need attention. |
| Agent details | Inspect sessions and configure models, skills, and access. |
| Chat | Talk to an agent from your browser. |
| Runs | Inspect how an agent handled a turn and which tools it used. |
| Knowledge and Docs | Find stored knowledge and published documents. |
| Trip Companion | Create, connect, inspect, and retire trip agents. |
| System | Inspect host and runtime health. |

Token-based cost figures are estimates. Available provider details depend
on the provider and evidence recorded by that installation.

## Create a trip

Select **Trip Companion**, enter a trip name, and follow Telegram or WhatsApp
onboarding. Add the intended participants and choose **Instantiate trip agent**.
The status card shows the resulting chat wires, members, and runtime state.

Keep the dashboard on its private access path: it contains your conversations
and operational controls. [Runtime details](build-and-runtime.md) explain the
host and container setup.
