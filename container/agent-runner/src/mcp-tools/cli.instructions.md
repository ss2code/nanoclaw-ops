## Admin CLI (`ncl`)

The `ncl` command is available at `/usr/local/bin/ncl`. It lets you query and modify NanoClaw's central configuration.

### Usage

```
ncl <resource> <verb> [--flags]
ncl <resource> help
ncl help
```

### Scope

Your CLI access may be scoped. Run `ncl help` to see which resources are available and whether args are auto-filled. Under `group` scope (the default), `--id` and group-related args are auto-filled to your agent group — you don't need to pass them.

### Resources

Run `ncl help` for the full list. Common resources:

| Resource     | Verbs                                                                                                                                     | What it is                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| groups       | list, get, create, update, delete, restart, config get/update, config add-mcp-server/remove-mcp-server, config add-package/remove-package | Agent groups (workspace, personality, container config) |
| sessions     | list, get                                                                                                                                 | Active sessions (read-only)                             |
| destinations | list, add, remove                                                                                                                         | Where an agent group can send messages                  |
| members      | list, add, remove                                                                                                                         | Unprivileged access gate for an agent group             |

Additional resources (available under `global` scope only): apps, ops-center, messaging-groups, wirings, users, roles, user-dms, dropped-messages, approvals.

### App catalog (`global` scope)

`ncl apps` is the stable @handle catalog for Jeeves-style supervision. Use it to resolve user-facing handles before delegating:

- `ncl apps list` — show known app handles and their purpose/read source.
- `ncl apps get @goa-trip` — resolve one handle exactly. Do not fuzzy-match unknown handles.
- `ncl apps create --handle goa-trip ...` — catalog and wire a new app after approval.
- `ncl apps update @goa-trip ...` — update purpose/read source/visibility after approval.
- `ncl apps retire @goa-trip` — soft-retire a handle and remove derived destinations after approval.

For `kind=agent`, creating or updating an app also projects the agent-to-agent destinations: Jeeves can send to the app using the handle, and the app can reply to Jeeves using `jeeves`.

Read source convention:

- `ops-center:/trips` or `ops-center` means read covered state first through Ops Center's local JSON read surface using `ncl ops-center domain`.
- `a2a` means ask the app directly with a message.
- `none` means the catalog is only descriptive.

### Ops Center read bridge (`global` scope)

Use `ncl ops-center domain` to read the host-mediated Ops Center snapshot. Do not curl localhost or `host.docker.internal`; the container cannot reliably reach the host-local Ops Center HTTP server directly. The host performs the local read and returns JSON over the normal `ncl` session transport.

The domain snapshot includes:

- live host/channel/queue health from Ops Center
- the app catalog
- Trip Companion summaries from the Ops Center trips reader

Use `ncl ops-center capabilities` when the user asks what Jeeves can do as Chief of Staff. Answer succinctly:

- resolve app handles from the catalog
- read Ops Center health and Trip Companion summaries
- ask registered apps for details
- relay app replies back to the user
- propose writes through approval, without reading private app DB files directly

### When to use

- **Looking up your own config** — `ncl groups get` or `ncl groups config get` to see your container config.
- **Restarting your container** — `ncl groups restart` (with optional `--rebuild` and `--message`).
- **Checking who's in your group** — `ncl members list`.
- **Seeing your destinations** — `ncl destinations list`.
- **Answering questions about the system** — query `ncl` rather than guessing.

### Access rules

Read commands (list, get) are open. Write commands (create, update, delete, restart, config update, add, remove) require admin approval — the request is held until an admin approves it.

### Approval flow

Write commands require admin approval. Here's what happens:

1. You run the command (e.g. `ncl groups config update --model claude-sonnet-4-5-20250514`).
2. The command returns immediately with an `approval-pending` response — it has **not** been executed yet.
3. An admin or owner gets a notification showing exactly what you requested, with approve/reject options.
4. Once the admin responds:
   - **Approved:** the command executes and the result is delivered back to you as a system message in this conversation.
   - **Rejected:** you get a system message saying the request was rejected.

You don't need to poll or retry — the result arrives automatically.

### Examples

```bash
# Read commands (no approval needed)
ncl groups get
ncl groups config get
ncl sessions list
ncl destinations list
ncl members list
ncl apps list
ncl apps get @goa-trip
ncl ops-center domain
ncl ops-center capabilities

# Write commands (approval required)
ncl groups restart
ncl groups restart --rebuild --message "Config updated."
ncl groups config update --model claude-sonnet-4-5-20250514
ncl groups config add-mcp-server --name rss --command npx --args '["some-rss-mcp"]'
ncl groups config add-package --npm some-package
ncl members add --user telegram:jane
ncl apps create --handle goa-trip --name "Trip Goa" --kind agent --type trip-companion --agent-group-id ag-trip-goa --purpose "Goa trip planning and ledger." --read-source ops-center:/trips --visibility shared
```

### Important

Config changes via `ncl groups config update` do not take effect until `ncl groups restart`. Run `ncl groups config help` for details.

### Tips

- Use `ncl <resource> help` to see all available fields, types, enums, and which fields are auto-filled.
- Flags use `--hyphen-case` (e.g. `--agent-group-id`), mapped to `underscore_case` DB columns automatically.
- `list` supports filtering by any non-auto column. Default limit is 200 rows; override with `--limit N`.
- Write commands return `approval-pending` immediately — don't treat this as an error. Wait for the system message with the result.
