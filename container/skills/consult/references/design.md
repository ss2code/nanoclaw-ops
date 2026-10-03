# Consult design and implementation contract

## Contents

1. Ownership boundary
2. Runtime sequence
3. Model and roster rules
4. Graph model
5. Exact and processed content
6. Filesystem layout
7. Retention and quotas
8. Security and concurrency
9. Command UX
10. Fixture-only verification

## 1. Ownership boundary

Consult is local to the invoking NanoClaw session. Its state root is
`/workspace/consultations`, which is on the per-session workspace mount.

This is deliberately narrower than `/workspace/agent`:

- Jeeves in one messaging session does not see consultation roots from another
  Jeeves session.
- A `sample-trip` application/session receives its own profile, roster cache,
  root counter, raw answers, and graph.
- No global consultation database, shared answer pool, or cross-session index
  exists.
- Cross-agent traffic contains only the question and correlation receipt needed
  for that request.

The runner code and read-only skill implementation are shared across
containers; all mutable consultation data is local.

## 2. Runtime sequence

### Fresh or expired roster

1. The user sends `/consult quick ...`.
2. The invoking runner sees that its local roster is absent or older than 24
   hours.
3. It sends deterministic `roster-probe` messages to addressable agent
   destinations. No provider is called.
4. Each target runner returns its provider, configured default model, tier map,
   effort, harness identity, and agent identity without calling its model.
5. The invoking runner stores those receipts locally, deduplicates by effective
   model, creates the root, and fans out the question.

### Answer and synthesis

1. A target runner rewrites the correlated request into one provider prompt.
2. The target model answers using its default configuration unless the original
   `/consult` command explicitly selected a tier for that target.
3. At the target's outbound database boundary, the runner attaches the request
   id, root/node ids, and actual local configuration receipt. The target model
   cannot accidentally omit this correlation metadata.
4. At the invoking runner, the structured response is archived to the pending
   answer node before it enters the invoking provider context.
5. When the expected answer set is complete, the runner rewrites the final
   inbound response into one lens-specific processing prompt. Earlier answers
   are retired without waking the invoking model separately.
6. The invoking model's delivered synthesis is archived at the outbound
   boundary as a different node and routed to the original user destination.

This interception also runs in the active-query follow-up poll. An answer that
arrives while the invoking model is already working follows the same capture
path and cannot bypass archival because of timing.

## 3. Model and roster rules

The default rule is absolute: use the target container's current configured
default model, provider/harness, effort, and default tier. Consultation does not
perform hidden upgrades, quality routing, subagent selection, or fallback model
selection.

Automatic target selection skips:

- an external container whose effective model equals the invoking model;
- a later container whose effective model duplicates an already selected
  target;
- a destination with no current roster receipt.

Consequently a nominal three-agent fleet may yield only one external answer.
That is correct when the other containers share a model.

An override is valid only when it is visible in the user's slash command, for
example:

```text
/consult quick --to atlas,errand-runner --tier atlas=high <question>
```

The request receipt records `modelMode=explicit-tier` and the requested tier.
Absent this flag it records `modelMode=default` and the target prompt explicitly
forbids switching.

`--tag` is different from the selection flags: it names a newly created root
and is accepted only on a start command. Later commands supply the tag directly
as a reference. Accepting and ignoring `--tag` on a continuation would make the
graph appear renamed when it was not, so the parser rejects that form.

## 4. Graph model

A topic root has an immutable id such as `C007` and a friendly tag such as
`atlas-switch`. Tags may acquire a numeric suffix on collision; immutable ids
never change.

Node ids are scoped to their root:

- `Q` — question or follow-up question
- `A` — exact external answer
- `C` — critique
- `R` — other derived analysis or revision
- `S` — synthesis
- `J` — judgment/referee result

Examples: `C007:Q0`, `C007:A1`, `C007:S1`.

Typed edges include `answers`, `continues`, `branches`, `critiques`, `derives`,
and `judges`. `/consult continue C007 ...` anchors to the root question.
Supplying `C007:A1` or `atlas-switch:A1` anchors to that exact answer branch.

The command grammar uses `REF` for any of these forms:

- root id: `C007`;
- friendly tag: `atlas-switch`;
- node through an id: `C007:A1`;
- node through a tag: `atlas-switch:A1`.

Starting, explicitly continuing, using, or reopening a topic selects it for
the caller. Selection and the last numbered topic-list snapshot live in
`index.json` under `participants`, keyed by channel, chat and sender. Senderless
legacy commands use a session selection. Asynchronous starts retain the
requester's key while the roster is refreshed.

`/consult more QUESTION` continues the selected whole topic without parsing a
reference from prose. `/consult topics` records a stable numbered snapshot;
`/consult use NUMBER` resolves only that snapshot. `/consult done` closes the
topic and clears selections referring to it. Close/delete/automatic closure
also clear those selections; another open topic is never silently selected.
Other participants retain their own selections. This does not change the
session-level data visibility boundary.

The advanced `continue` and `branch` commands still require an explicit REF.
Inspection commands fall back to the caller's selection. Readable topic titles
are derived from the first question; immutable ids and aliases remain valid.

A lens is stored on every question node. The root question inherits the start
lens; each continuation or branch may override it with `--lens`. When that
question's answer quorum completes, automatic processing reads the question's
lens rather than accidentally reverting to the root default.

Continuation context is reconstructed from the graph snapshot rather than
from provider conversation history. A root/tag continuation includes the
original question and earlier completed turns in chronological order. A node
continuation follows only the selected node's ancestor chain, which keeps a
branch from importing unrelated sibling discussion. For each earlier question,
the completed local processed result is preferred; exact answer nodes are the
fallback while processing is pending. The runtime caps the injected history at
12,000 characters and each node at 5,000 characters, always retaining the
original question. Historical text is explicitly marked as quoted reference
material so old prompt-like text cannot become an instruction to the target.

## 5. Exact and processed content

Each content-bearing node owns a separate UTF-8 text file and SHA-256 digest.
An answer receipt includes source agent, source group, provider, effective
configured model, effort, tier map, requested override, request id, and capture
time.

"Exact" means the exact text delivered across the NanoClaw agent boundary. In
a hardened target, mandatory outbound scrubbing happens first; secret-shaped
text removed by the security layer is never re-exposed through Consult.

Processed output is independently archived. The graph can therefore show what
another model said verbatim, which source nodes a local synthesis used, which
lens was applied, and what processed text the invoking agent delivered.

`graph.json` is the canonical self-contained snapshot for continuation,
rendering, and debugging. Its `nodes` array mirrors each completed node's full
text in a `content` field and uses `content: null` for pending nodes; its root
envelope mirrors the identity and protocol metadata from `root.json`. The
separate text files remain the exact capture artifacts and attachment source,
so the snapshot does not replace the audit boundary or change the existing
retention/quota behavior.

Chat remains compact: `/consult sources` gives bounded previews and hashes;
`/consult raw C007:A1` returns short text inline; long raw text is copied through
the normal outbox as a `.txt` attachment.

## 6. Filesystem layout

```text
/workspace/consultations/
  index.json                 local profile, roster cache, recent/closed/trash ids
  events.jsonl               metadata audit events; never raw prompts
  roots/
    C007/
      root.json              identity, original reply route, protocol, roster snapshot
      graph.json             self-contained root, nodes, typed edges, and node content
      content/
        Q0.txt
        A1.txt
        S1.txt
  trash/
    C003/                    recoverable root directory
```

Writes use a temporary sibling followed by atomic rename. The runner is the
only logical writer in a session, and synchronous engine calls serialize the
occasional provider-event/follow-up overlap. WebQI reads this snapshot through
a session- and root-validated endpoint; it never accepts a filesystem path
from the browser.

## 7. Retention and quotas

Defaults are intentionally bounded:

- recent/open roots: 3;
- closed roots: at most 20 and at most 30 days;
- trash roots: at most 10 and at most 7 days;
- total local consultation store: 64 MiB.

Creating a fourth recent root auto-closes the oldest. Closing preserves data.
Deleting moves a root to recoverable trash. Closed overflow moves to trash;
trash overflow or expiry is permanently pruned.

Quota pruning removes trash first and then the oldest closed roots. It never
silently destroys an open root. When only open roots remain above quota, new
root/branch/processing creation is refused until the user closes or deletes
material. Already pending correlated answers may still be captured so an exact
answer is not lost halfway through a consultation.

## 8. Security and concurrency

- Agent-to-agent ACLs remain authoritative.
- Internal probe/request envelopes are accepted only on `channel_type=agent`.
- Roster receipts must match the current refresh id.
- Answer receipts must match an existing pending request id and answer node.
- State paths use runtime-generated ids, not user path fragments.
- No prompt or answer is copied to the central delegation ledger.
- No model credentials are read, stored, or moved by the skill.

## 9. Command UX

The dedicated namespace avoids accidental consultation spend. Ordinary
conversation remains with the current model. `/skill consult` and
`/run consult` are rejected so there is one predictable grammar.

Help is verbose but topic-paged for chat:

```text
/consult help start
/consult help references
/consult help protocols
/consult help lenses
/consult help models
/consult help continue
/consult help inspect
/consult help lifecycle
/consult help examples
/consult help all
```

`/consult ask [--tag TAG] ... QUESTION` starts with the profile's configured
default protocol; it accepts the same start options as a named method.

Every lens name is also a new-topic shortcut:

```text
/consult distill --tag health-question What could explain this pain?
/consult critique --tag rollout-risk Is this rollout safe?
```

These use the profile's configured default protocol and select the named lens.
They contact external agents. Reprocessing existing graph sources remains the
explicit `/consult lens [REF] LENS` form, avoiding ambiguity about whether a
new question is being sent.

The parser normalizes a Unicode dash immediately before a known option, such as
`—tag`, to the canonical two-ASCII-hyphen spelling. This accommodates common
mobile-chat punctuation substitution without changing dashes inside questions.

Long help is packed into numbered WhatsApp/Telegram-sized parts at section
boundaries, never in the middle of an explanation when a whole section fits.

Basic help leads with ask/more/topics/sources/done. Advanced reference help explains:

```text
REF = ROOT, TAG, or NODE
```

`--tag` appears only in advanced start syntax. Everyday examples need no tag;
advanced examples use the tag directly for later inspection and continuation.

The three lens forms are intentionally separate:

```text
/consult distill --tag pricing Is this plan sound?
```

This starts a new externally consulted topic using the profile's default
protocol and the named lens.

```text
/consult quick --tag pricing --lens critique Is this plan sound?
/consult continue pricing --lens counsel What should we do next?
```

These commands ask external models a new question and use the selected lens for
automatic local processing after replies arrive.

```text
/consult lens pricing steelman
/consult lens pricing:A1 critique
/consult lens referee
```

These commands reprocess sources already in the graph and do not contact
external agents. The last form recognizes `referee` as a lens and uses the
active root. The local invoking model still performs the processing.

## 10. Fixture-only verification

The suite never invokes a provider. Fixture identities and canned answers cover
daily and explicit roster refresh, duplicate-model suppression, default and
explicit-tier envelopes, every protocol and lens, root/node branches, every
graph view, exact and processed capture, active-stream reply timing, retention,
session isolation, slash-only invocation, start-only tag validation, top-level
lens start shortcuts, mobile-option dash normalization, active-root lens
shorthand, and per-question continuation lenses.

```text
bun test container/skills/consult
bun test container/agent-runner/src/consult-correlation.test.ts
bun test container/agent-runner/src/chat-commands.test.ts
```

## Conversation UI and help

WebQI is labeled Consult and renders completed question/answer turns, with
original model answers expanded on demand. The composer defaults to whole-topic
continuation, preserving completed history. Explicit “Explore separately” uses
a node reference and ancestor-only context. New-topic links from Chat preserve
the group and originating web session. Model settings and graph details are
secondary controls. The exact-source links and full conversation remain read-only.

The web help and `/consult help` read `references/help.json` as copy data. Basic
help fits in one message; full help remains topic-paged. The normal chat palette
lists ask/more/topics/done. No ordinary message implicitly starts a panel.
