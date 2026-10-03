# Remove a knowledge-graph tutor instance

Resolve the exact agent group first:

```bash
pnpm exec tsx templates/education/knowledge-graph-tutor/host/admin.ts status <agent-group-id> --json
```

For a real instance, export and verify student/profile memory plus course data before removal. Then remove central state while retaining the group directory:

```bash
pnpm exec tsx templates/education/knowledge-graph-tutor/host/admin.ts delete <agent-group-id> --yes
```

For a disposable synthetic UAT instance only, remove central state and the exact group/session directories:

```bash
pnpm exec tsx templates/education/knowledge-graph-tutor/host/admin.ts delete <agent-group-id> --yes --purge
```

Report whether files were retained or irreversibly purged.
