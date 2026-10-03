---
name: trip-docs
description: How shared trip documents (master itinerary, research, plans, recap/scrapbook) are created, composed from trip.db, versioned, rendered to PDF, and optionally deployed. Use when creating, updating, viewing, sending, or composing a recap. Keeps one canonical file per document.
---

# trip-docs — one document, one file, a legible trail

A shared trip document is a **collaboration object the group edits by talking**,
not a publication. People react, you fold their input in, you re-share. The chat
is append-only, so naive re-sends pile up four near-identical files and a member
who's been away can't tell which is current or what changed. This skill fixes that
on the channel itself: **one canonical file, versioned in place; the chat carries a
diff, not a fresh copy every time.**

You **author and version styled HTML**. For a trip master document, the structural
sections are generated from `trip.db` and authored prose lives in
`blocks/<slug>/*.html`; `compose` merges them. What you deliver to the chat is
usually a PDF rendered from the canonical HTML (`trip-docs render`). If the user
asks to update the hosted page, call the generic `artifact-deploy` skill; this
skill owns document format, not deployment.

Master documents always use `#` section tags (for example `#day-2` and
`#stays-portree`), never `§`. The composer upgrades legacy `§` markers to `#`
throughout the document. Every master document starts with a generated Quick
summary linking to the detailed route, travel, stays, budget, research, and
day-by-day sections.

```bash
TD="bun /app/skills/trip-docs/scripts/trip-docs.ts --dir /workspace/agent"
```

## 1. Create once

```bash
$TD new sample-research --title "Sample Trip Research" --type research
$TD new sample-trip --title "Sample Trip — Master Document" --type master
```

Scaffolds `<slug>.html` at **v1** with version markers, revision history,
References, and print-ready CSS. `--type master` creates the standardized running
trip document with generated regions and prose block stubs under
`blocks/<slug>/`. Do this **once per document** — never `new` a doc that already
exists.

## The recap — a keepsake, not a bill

When the trip reaches `trip_complete` or `post_trip`, offer once to create the recap. First run two or three fun polls with questions beginning `[superlative]` (for example, `[superlative] Trip MVP?`). Then scaffold, add warm prose blocks from the diary, compose, render, and send the PDF. The generated recap includes the route, facts, day cards, indexed photos, diary moments, and superlatives. It deliberately contains totals only—never balances or debts.

```bash
$TD new sample-recap --title "Sample Trip — The Recap" --type recap
$TD compose sample-recap --db /workspace/agent/trip.db
$TD render sample-recap
```

Its authored prose lives in `blocks/sample-recap/{intro,highlights,outtakes}.html`; structural regions are hash-guarded exactly like the master document.

## 1a. Master documents are RENDERED VIEWS — never hand-write structure

**The iron rule for `--type master`: structural content lives in `trip.db`, prose
lives in `blocks/<slug>/`, and the HTML is output only.** If the group adds a stop,
changes nights, picks a hotel, or books a ticket, you enter it with the
**trip-planning / trip-core** CLIs and then:

```bash
$TD compose sample-trip --db trip.db
```

`compose` regenerates the Quick summary, route strip (schematic SVG map: stops
sized by nights, mode + duration per segment — always present, PDF-safe), the
calendar ribbon, travel legs, segments, stays, budget rollup, day-by-day cards,
and the whole Operations tab (decisions, open questions, booking ledger,
changelog) — while preserving your prose blocks. Each `#day-N` card includes the
overnight stay for that date, a Google Maps route from the start-of-day source
through the day's points to the end-of-day destination, and research links for
each place. The Google Maps route link calculates the route distance and travel
time; any known trip.db travel time is shown beside it. Never type a route table,
stay row, or day card into the HTML yourself: generated regions are hash-guarded
and compose will **refuse** if one was hand-edited. That refusal means "put the
data in trip.db instead".

Authored prose goes in `blocks/<slug>/*.html`, slotted by name: `intro` (where
planning stands), `options` (route alternatives under discussion — compare-cards),
`sights`, `food`, `weather`, `packing`, `references`. Keep them **rich but tight**,
and list in References only **verified URLs you actually opened** — never invent
or guess one.

Two flags:

- `--hosted` additionally embeds the interactive **Leaflet geographic map**
  (pinned CDN + OSM tiles) — use it **only** for the file you hand to
  `artifact-deploy`. The plain compose (no flag) is the local default; its map is
  the SVG strip, which is what the PDF carries.
- `--rebuild` regenerates the shell from the current template while keeping the
  version + revision history and prose blocks — use after a trip-docs template
  upgrade, or to recover a shell someone hand-damaged.

Deploy flow when asked to "update the page":
`compose --hosted` → `bump` (if meaningful) → `artifact-deploy … deploy` →
verify the draft URL → `compose` again (no flag) so the canonical workspace file
stays the local variant. The deploy is exactly those steps — do **not** run
`set-password` as part of it. The page is encrypted only when the operator has
already set a passphrase (otherwise the deploy is public); inventing a passphrase
the operator did not choose locks them out of their own document. Do not
publish/promote the draft unless the user explicitly asks.

## 2. Update in place — every meaningful change goes through `bump`

```bash
$TD bump sample-research --summary "revised the day-two activity options"
$TD show sample-research      # read back: current version + recent revisions
```

`bump` increments the version, refreshes the date line, and prepends a revision
entry — **all in the same file**. Make your content edits first, then `bump`.
Do **not** hand-edit the version number, and do **not** save the new version as a
new file. The `DOC UPDATED …` line it prints is your proof the version moved; relay
it rather than claiming "updated" on faith.

(If a legacy document has no version markers yet, the first `bump` inserts them and
starts it at v1 — in place, no second file.)

## 3. Decide whether to *send* it — this is the part that keeps the chat clean

Editing or composing the local HTML is silent. Re-attaching a PDF or updating a
hosted page is a deliberate act. Send or deploy **only** when one of these is true:

| Situation | What to do |
|---|---|
| Someone explicitly asks ("send the doc", "latest version") | `render`, then send the **PDF**. |
| Someone asks "update the page" / "put it online" | `compose`, `bump` if meaningful, then use `artifact-deploy` to create and verify a draft deploy (never `set-password`); reply in WhatsApp with the draft URL + version. |
| The plan changed **significantly** (decision made/reversed, option added/dropped, restructure) | `compose`, `bump`, then ask whether they want the PDF or hosted page updated unless they already asked. |
| A **minor** change (wording, one fact, a typo) | Say what changed in one line. **Don't** bump, **don't** render, **don't** attach. |
| You're unsure if it's worth sending | Ask "Want the updated file?" — don't auto-send. |

Whenever you send to chat, **render the PDF from the canonical HTML and attach
that** — never the `.html` master:

```bash
$TD render sample-research    # writes sample-research.pdf next to the HTML
```

Refer to the document by a **stable, versioned title** (`Sample Trip Research v4`) and
lead with **what changed since the last version**. Never label two sends the same
way ("updated", "(updated)" twice) — that's exactly the confusion this skill exists
to kill.

## What goes where

| Want to… | Use |
|---|---|
| Create / update / compose a user-facing document (master, research, plan, itinerary, recap) | **trip-docs** (this skill) |
| Deploy/update a hosted HTML page | **artifact-deploy** |
| Remember a durable preference / taste | `memory remember` (see trip-core rules) |
| Record a live leaning / "still deciding" or a settled decision | `trip-core` (scratchpad / decisions) |

## Help — recite on "how do you handle documents?"

> I keep each trip document as one living, version-stamped master and update it in
> place — so there's always a single current copy, never four "updated" ones
> cluttering the chat. Each version stamps what changed and when, right inside the
> doc, and every doc ends with a References section listing the verified links
> behind it. I don't re-send it every time I tweak it: for small edits I just tell
> you what changed; when you ask or the plan really moves, I render it to a PDF and
> send that — leading with what's different and which version it is, so anyone
> catching up can follow the trail.
