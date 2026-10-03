---
name: archive-trip
description: Finalize a completed Trip Companion agent group by verifying its trip-domain stage, pausing host wakes, creating and verifying a self-contained archive, then purging the central records, group workspace, and session tree. Use when a trip is finished and its archive is the only retained copy.
---

# Archive and Purge Trip

For the complete setup-to-teardown operator runbook, see
`docs/trip-companion-lifecycle.md`.

Use this skill for final host-side Trip Companion teardown. The `trip-core`
skill owns the domain lifecycle (`trip_complete → post_trip → archived`); this
skill owns the final archive and purge. It is destructive after the archive has
been verified, so require explicit `--yes` confirmation.

## Workflow

1. Identify the agent group. Prefer the stable group id from
   `pnpm exec tsx scripts/trip-admin.ts list`.
2. Run a read-only preflight:

   ```bash
   pnpm exec tsx .claude/skills/archive-trip/scripts/archive-trip.ts preview \
     --id <agent-group-id> --json
   ```

   Continue only when the trip-domain `stage` is `archived` (or `cancelled`)
   and all session databases report zero pending or in-flight work. Resolve
   pending work before archiving; do not silently discard it.
3. Create and finalize the archive with an explicit confirmation flag:

   ```bash
   pnpm exec tsx .claude/skills/archive-trip/scripts/archive-trip.ts archive \
     --id <agent-group-id> --yes
   ```

   The script asks the running host to persist `desired_state=paused`, waits
   for live containers to stop, and writes a compressed snapshot under
   `data/trip-archives/`. The bundle contains the group workspace, session
   databases, `manifest.json`, and a trip-scoped `host-records.json` export.
   It excludes `groups/<folder>/node_modules` by default because `package.json`
   and lockfiles are preserved; add `--include-node-modules` only when an
   offline runtime copy is required.
4. Before purging, the script verifies the required archive entries and SHA-256,
   writes the sidecar manifest, then removes the central agent-group cascade,
   `groups/<folder>/`, and `data/v2-sessions/<agent-group-id>/`. It verifies
   that the central row and both filesystem paths are gone before succeeding.
5. Copy the `.tar.gz` and `.manifest.json` to independent storage and retain
   the printed SHA-256. There is no normal resume path after this skill runs;
   reopening requires a future restore workflow from the archive.

Do not run `trip-admin delete` separately after this skill. The archive command
already performs the central cascade and on-disk purge.

## Archive artifacts

Each archive has a `.tar.gz` bundle and a sidecar `.manifest.json` containing
the group id/folder, trip stage, lifecycle state, wires, session metadata,
archive contents, exclusions, byte size, and SHA-256. The bundle's
`host-records.json` contains the relevant host-side rows needed to understand
the deleted wiring and membership records.

The bundled script is intentionally host-side. The container already has the
correct domain behavior: `trip-core heartbeat` returns `wakeAgent: false` for
`archived` and `cancelled` stages. Once the host purge completes, no container
can be woken for the deleted group.
