# Removing nano-pvt-hub

Reverse of the install. Safe to run partially.

1. **Stop exposing it (if you ran `tailscale serve`)** — only if nothing else
   needs the Ops Center on the tailnet:
   ```bash
   tailscale serve --https=443 off
   ```

2. **Revert the Ops Center Docs surface** (`ops-center/` is fork-only): remove
   `resolveHubFile`/`serveHubFile`/`hubBody` and the `/hub` routes from
   `ops-center/server.ts`, drop `PATHS.hubDir` in `ops-center/config.ts`, and
   restore the Docs tab in `ops-center/ui.ts` to `['/docs/', 'Docs', '✎']`.
   Restart Ops Center.

3. **Remove the container mount + skill wiring** (Phase 2): delete
   `buildHubMount` and its `mounts.push(...)` in `src/container-runner.ts`,
   remove the hub pointer from `container/CLAUDE.md`, and drop `nano-pvt-hub`
   from each group's `container.json` skills. Remove the row in
   `docs/fork-customizations.md` and the gotcha in `.claude/skills/update-fork/`.

4. **Delete the skill copies**:
   ```bash
   rm -rf .claude/skills/nano-pvt-hub container/skills/nano-pvt-hub
   ```

5. **Delete the store** — this destroys all published dashboards/trackers/agent
   docs (NanoClaw Docs are just a symlink to `docs/`, so nothing there is lost):
   ```bash
   rm -rf data/hub
   ```
