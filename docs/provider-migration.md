# Switching an agent group between providers

How an **operator** moves a live agent group from one agent provider to another (for example OpenCode → Pi or Claude → Codex) and back. Switching is an operator action: it runs from the host via `ncl groups config update --provider` + restart.

NanoClaw's runtime does not migrate anything when you switch. Provider-neutral state simply stays where it is; provider-specific state (memory, in-flight context) stays with its provider, and carrying memory across is a separate, explicit operator step (`/migrate-memory`, executed by your coding agent).

## Preconditions

1. **The target provider is installed** — run its `/add-<provider>` skill and rebuild the container image (`./container/build.sh`). If the provider isn't installed (or the name is a typo), the container fails at boot and the host surfaces its last words in the logs: look for `Container exited non-zero` with a `stderrTail` like `Unknown provider: codexx. Registered: claude, codex`.
2. **Auth is configured** — each provider documents its own auth in its install skill. Codex uses a ChatGPT subscription or API-key secret in OneCLI. Pi uses group-scoped native OAuth for xAI subscriptions and a OneCLI-injected key sentinel for OpenRouter.

## Switching

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

For Pi, keep the model as a canonical `provider/model` ID. A first Ops Center switch from OpenCode to Pi carries the existing model/tier profile, so xAI and OpenRouter model IDs do not drift during the harness change.

Sessions resolve their provider at container spawn (`sessions.agent_provider` is only set when you've explicitly pinned a session), so existing sessions pick up the new provider on their next wake.

## What carries over automatically

| State | How |
|-------|-----|
| Group identity, wiring, members, roles, destinations | Provider-neutral, in the central DB — untouched |
| Container config (model aside), skills, MCP servers, packages, mounts, cli_scope | Provider-neutral — untouched |
| Workspace files (`groups/<folder>/` — notes, data files the agent created) | Same workspace, mounted for every provider |
| Conversation archives (`conversations/`) | Provider-neutral markdown — readable by the new provider |
| Agent surfaces (system instructions / project docs) | Composed fresh at every spawn from the same sources — nothing to migrate |

## What does NOT carry over

- **Agent memory.** Each provider keeps its own store: Claude's per-group memory is `CLAUDE.local.md` in the workspace; scaffold providers (e.g. Codex) keep a `memory/` tree. Neither is touched by a switch — the old store sits intact, the new provider starts with its own. To carry memory across, run **`/migrate-memory`**: your coding agent reads the source store, distills it into the target store (copy, never move), and restarts the group. Both directions work.
- **In-flight conversation context.** Continuations are provider-specific (a Claude SDK session, a Codex thread) and stored in separate per-provider slots — the new provider starts a fresh thread. The old slot is kept, not deleted. Recent context is recoverable from `conversations/` archives.
- **Provider state dirs** (`.claude-shared/`, per-session `.codex-shared/`, group-scoped `.pi-shared/`). Each provider keeps its own; they sit idle while unused and are reused if you switch back. Pi transcripts and health receipts remain session-local under `pi-sessions/` and `pi-observability/`.

## Rolling back

```bash
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

Rollback is lossless by construction: the per-provider continuation slot means Claude resumes its previous session (subject to normal transcript-rotation age limits), and `CLAUDE.local.md` was never modified by the switch. Memory written **while on the other provider** lives in that provider's store — run `/migrate-memory` again if you want it carried back.

Ops Center provider switches are compensating operations: if the target provider does not answer the isolated validation probe with a target-specific continuation, Ops Center restores the source model profile, requests a fresh restart, verifies the source provider in central config, and records the operation as `rolled_back`. This prevents a failed pilot from leaving a critical group configured on the unverified harness. Keep an explicit saved Codex profile for critical OpenAI-backed fallbacks such as Jeeves.
