# Agent delegation policy templates

Direct delegation is configured as a versioned JSON template under
`config/agent-delegation-templates/`. A template has five parts:

- `source` — the app handle or agent group that owns the work.
- `targets` — specialist apps/groups and their local destination names. Each
  target creates a bidirectional route so replies can return without a
  supervisor hop.
- `policy` — the data and work boundary: what is appropriate to delegate,
  whether credentials may cross the boundary, who verifies the result, and
  where to escalate.
- `structure` — the expected request/response shape and hop limit.
- `configuration` — runtime switches. Direct templates must be bidirectional;
  the host ACL remains authoritative and file forwarding uses the existing
  path-safety checks.

## Apply and revoke

Templates are applied by name through the host CLI:

```text
ncl delegation-policies apply --template sample-trip-direct-workers
ncl delegation-policies list
ncl delegation-policies get sample-trip-direct-workers
ncl delegation-policies revoke --id sample-trip-direct-workers
```

Applying is idempotent. Revoking removes only destination rows created by that
template. A pre-existing row—such as Sample Trip → an owner agent—is retained. Live
session destination projections are refreshed; no container restart is needed.
The first activation needs the host's next normal startup to run migration 025;
after that, applying or revoking a template is a live ACL change.

## Current direct-worker policy

`sample-trip-direct-workers.json` allows Sample Trip to address:

- `@scout` — Errand Runner for bounded public/research work and artifacts.
- `@atlas` — Atlas for complex analysis, code, or independent review.

The source agent remains responsible for verification and final delivery.
Private credentials, authenticated actions, private memory, approvals, and
cross-trip coordination remain with the owner's agent. If a direct destination
is absent or revoked, the source can use its existing owner-agent route.
