# Knowledge-graph tutor UAT

Run `nvm use 22` before host-side lifecycle and live-UAT commands. The NanoClaw
host dependency tree contains a native `better-sqlite3` binary built for the
repository's Node 22 contract.

## CLI gate

1. Run `bun test templates/education/knowledge-graph-tutor/app/test`; require zero failures.
2. Apply an untracked copy of `config-examples/knowledge-graph-tutor.synthetic.json`.
3. Run lifecycle `status --json`; require three `shared` wires, two approved fake students, and course revision 1.
4. Confirm the structured fixture reports three concepts, two prerequisite edges, six questions, two questions per difficulty, one duplicate, and at least one alias proposal.
5. Inspect the raw angles fixture; require `inputMode=raw_source`, `canonicalizationRequired=true`, and `commitAllowed=false`.
6. Inspect the malformed fixture; require warnings, quoted instruction-like text, and a blocked commit.

Then run the real two-student CLI UAT:

```bash
pnpm exec tsx scripts/knowledge-graph-tutor-uat.ts \
  <config.json> --json
```

Require 14 passing checks across eight replied-to turns. The UAT must report
three distinct session IDs for the tutor-control route and two student routes.

## Container and routing gate

1. Send one message to tutor control, Student A, and Student B.
2. Run `ncl sessions list`; require three distinct sessions for one agent group.
3. Ask each chat for help. Student chats must not list ingestion, graph administration, roster, intervention, or export commands.
4. In Student A, store the harmless canary `ORCHID-A-ONLY` as a learning preference.
5. In Student B, ask for that canary and Student A's profile. Require no data and no existence signal.
6. In Student A, attempt coursework ingestion, a graph edit, roster access, and profile-memory export. Require denial before mutation.
7. Ask both students the same CKG question. Require the same graph revision and separate current actions/evidence.
8. From tutor control, queue one medium review for Student A. On Student A's next turn require one applied command; Student B must apply zero.
9. Repeat the same attempt idempotency key in Student A. Require one learning event.
10. Create a schedule from Student A's own chat and wait for delivery. Require delivery only to Student A's origin group.

## Telegram gate

The preferred manual surface is the **Tutor Foundry** tab in Ops Center. Open
the normal local or trusted remote Ops Center address and select it in the left
navigation. Locally, the direct path is:

```text
http://127.0.0.1:10333/tutor-foundry
```

Configure the BotFather token through NanoClaw's normal channel/setup surface,
then use Tutor Foundry's Configuration tab for tutor/student pairing and
instantiation. Use its Status tab to verify roster, graph revisions,
pause/resume and cleanup; common routing and session details belong in the
other Ops Center tabs. The gates below are still
the acceptance authority; the web page does not weaken them.

1. Use one tutor-control Telegram group and two private fake-student groups containing tutor, bot, and one fake student each.
2. Put the discovered numeric chat IDs in the config and re-apply it.
3. Confirm every wire remains `shared` and session IDs remain distinct.
4. Upload one synthetic UAT Base_doc only in tutor control. Review alias, duplicate, answer-alignment, and coverage warnings before approving. Keep the supplied Base_doc untouched.
5. Repeat the routing canary, student admin denial, targeted review, and schedule-delivery tests above.

## Go/no-go

Do not enrol real students if any of these fail: distinct sessions, canary isolation, tutor-only exports, blocked student mutations, target-specific command application, source provenance, or origin-only schedule delivery. Record that arbitrary-shell isolation is outside the container-only MVP.

For serialized persona tuning, require an explicit pinned model and a passing model attestation in the final receipt. Use Haiku 4.5 for repeated tuning cycles. Use `--checkpoint each-persona` when human review is desired; resume only without changing the model, or start a separate clean comparison run for Sonnet/another stronger model. Never combine different models into one quality score.

## Cleanup

For the synthetic instance, run:

```bash
pnpm exec tsx templates/education/knowledge-graph-tutor/host/admin.ts delete <agent-group-id> --yes --purge
```

Confirm `status` reports the group absent and that only the exact disposable group/session directories were purged.
