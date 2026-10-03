---
name: add-pi
description: Install, authenticate, switch, validate, and troubleshoot Pi as a NanoClaw agent provider for xAI subscription and OpenRouter models. Use when replacing OpenCode with Pi or configuring a non-OpenAI group to use Pi while retaining Codex as a fallback.
---

# Add Pi provider

Pi runs as a headless JSONL RPC child process. NanoClaw owns the MCP bridge, session lifecycle, liveness receipts, and provider registration; Pi owns model execution and xAI OAuth state.

## Preflight

Treat Pi as installed only when all checks pass:

- `src/providers/pi.ts` exists and the host provider barrel imports it.
- `container/agent-runner/src/providers/{pi,pi-rpc,pi-mcp-bridge,pi-mcp-extension}.ts` exist and the container barrel imports `pi`.
- `container/cli-tools.json` contains exactly `@earendil-works/pi-coding-agent@0.87.0` without `onlyBuilt`.
- The host and container registration tests pass.

Reapplying is idempotent: do not add duplicate barrel imports or manifest entries. The provider payload is fork-owned; restore the files from the fork revision that contains this skill when any preflight file is absent.

## Validate and build

Run the focused contracts first, then all project checks:

```bash
cd container/agent-runner
bun test src/providers/pi-mcp-bridge.test.ts src/providers/pi-rpc.test.ts src/providers/pi.test.ts src/providers/pi.factory.test.ts src/providers/pi-cli-tools.test.ts
cd ../../..
./scripts/run-node22.sh node_modules/vitest/vitest.mjs run src/providers/pi-host-contribution.test.ts src/providers/pi-registration.test.ts ops-center/provider-switch.test.ts ops-center/pi-observability.test.ts
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec tsc -p ops-center/tsconfig.json --noEmit
./container/build.sh
```

Probe the built image with `pi --version`. Rebuild the host after the image succeeds so the Pi mount/env contribution is registered.

## Authentication

For OpenRouter, keep the real API key only in OneCLI with an `openrouter.ai` host pattern. Pi receives `OPENROUTER_API_KEY=onecli-managed`; the gateway substitutes the secret on the wire.

For xAI subscription, use Pi's provider-owned OAuth state. Run the image interactively with the group state mounted at `/home/node/.pi/agent`, enter `/login xai`, choose subscription login, and finish the displayed browser/device flow. Never copy this credential into `.env`, chat, or OneCLI.

The group-scoped state path is `data/v2-sessions/<group-id>/.pi-shared/auth.json` and must remain mode 0600. Authentication does not require a session reset.

## Switch a group

Preserve the full model/tier profile. Pi expects canonical `provider/model` IDs such as `xai/grok-4.6` or `openrouter/z-ai/glm-5.3-flash`.

```bash
ncl groups config update --id <group-id> --provider pi
ncl groups restart --id <group-id> --fresh
```

Use Ops Center's provider switch when available. It saves provider profiles, runs an isolated model probe, and automatically executes and verifies the prior-provider rollback if the probe fails. Switching to Pi from OpenCode carries the current model tiers on the first visit.

Before switching a critical group, save its intended fallback provider profile in the Ops Center snapshot ledger. For Jeeves, keep a Codex profile (`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`) so “Use Codex / ChatGPT” is a one-action fallback.

## MCP and observability contract

- Preserve tool names as `mcp__<server>__<tool>` so existing instructions and memories remain valid.
- `nanoclaw` tools are eager. External tool schemas are registered but deferred behind `ToolSearch`; activation is additive.
- Forward every MCP tool call exactly once. Never retry a call after an unknown outcome.
- A missing required `nanoclaw` server fails startup. Optional servers degrade independently.
- Health goes to each session's `pi-observability/mcp-health.json`; bounded structural events go to `events.jsonl`.
- Never log prompts, tool arguments/results, headers, environment values, or credentials.

Ops Center reads these receipts and shows server readiness, catalog/active counts, calls, errors, latency, and the last event. A missing receipt means Pi has not started in that session; it is not proof of health.

## Troubleshooting

- `spawn pi ENOENT`: rebuild the image; the CLI manifest pin is not deployed.
- `Invalid Pi continuation path`: start fresh; only `/workspace/pi-sessions/*.jsonl` is accepted.
- Required `nanoclaw` MCP failure: inspect the container exit tail and the session health receipt before retrying.
- xAI auth errors: rerun Pi `/login xai` against the exact group's `.pi-shared` mount.
- OpenRouter auth errors: inspect OneCLI secret matching and agent secret mode; do not paste the key into container config.
- A failed switch probe should end as `rolled_back` in the Ops Center operation ledger. If it does not, use the saved Codex provider profile explicitly and restart fresh.
