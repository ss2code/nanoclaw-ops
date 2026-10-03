# Remove Pi provider

Stop or switch every Pi group to another installed provider before removal.

1. Delete `import './pi.js';` from `src/providers/index.ts` and `container/agent-runner/src/providers/index.ts`.
2. Delete `src/providers/pi.ts` and its Pi host tests.
3. Delete `container/agent-runner/src/providers/pi.ts`, `pi-rpc.ts`, `pi-mcp-bridge.ts`, `pi-mcp-extension.ts`, and all Pi provider tests.
4. Remove the `@earendil-works/pi-coding-agent` object from `container/cli-tools.json`.
5. Remove Pi support from Ops Center provider-switch types, API validation, UI, verified rollback logic, and `readers/pi-health.ts`; delete `ops-center/pi-observability.test.ts`.
6. Remove the Pi entries from `docs/fork-customizations.md`, `docs/provider-migration.md`, and `/update-fork`.
7. Re-run all host/container/Ops checks and rebuild the image.
8. After confirming no group uses Pi, archive or delete each group’s `data/v2-sessions/<group-id>/.pi-shared` and session-local `pi-sessions`/`pi-observability` directories according to the operator’s retention policy.

Provider state contains authentication material and transcripts. Do not delete it implicitly, print it, or commit it.
