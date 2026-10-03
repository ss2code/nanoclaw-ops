# trip-docs — always-on rules

This trip keeps its user-facing documents (master itinerary, research, plans) as
**styled HTML files in `/workspace/agent`**, versioned with the **trip-docs**
skill. Master documents are composed from `trip.db` plus
`blocks/<slug>/*.html`; PDFs and hosted pages are delivery modalities of the same
canonical HTML.

```bash
TD="bun /app/skills/trip-docs/scripts/trip-docs.ts --dir /workspace/agent"
```

**1. One canonical file per document — always edit in place.** Never create a
second copy for a new version: no `… (updated).html`, no `…-v2.html`, no
date-stamped duplicates. The whole point is that a member who scrolls back finds
*one* file, not four. If a document already exists, you update it; you do not make
another. The `.pdf` is a derived copy — never edit or version the PDF, and never
send the `.html` master itself.

**2. Keep documents rich but tight, and always include a References section.**
Style them like a real document — clear section headings, embedded links, a small
table or diagram where it genuinely aids understanding — but don't pad: every line
should earn its place. Each document ends with a **References** section (the
`<section id="references">` the scaffold seeds) listing the **verified URLs** you
actually opened and confirmed — sources for facts, bookings, opening hours, prices.
List only links you've checked; never invent or guess a URL.

**2a. Use `#` section tags everywhere.** The document vocabulary is `#day-1`,
`#stays-portree`, and similar tags. Never write `§day-1` or any other `§` tag;
the composer normalizes legacy markers to `#` when it rewrites a document.

**2b. Make every day card self-contained.** Each `#day-N` section must show
where the group is staying that night, a Google Maps route link from the day's
start point through its travel/activity points to its final destination, and a
research link for every place mentioned. Google Maps supplies the route distance
and current travel time; do not invent a distance when the data is missing.

The generated Quick summary appears at the top and links to the detailed route,
travel, stays, budget, research, and day-by-day sections. Keep those links and
the `#day-N` anchors stable when adding prose.

**3. Route every meaningful change through `bump` — don't hand-edit the version.**

```bash
$TD new <slug> --title "<Title>" --type master|research|free   # first time only
$TD compose <slug> --db trip.db              # master only: regenerate from trip.db + prose blocks
$TD bump <slug> --summary "<one line of what changed>"   # every meaningful change
$TD show <slug>                              # read back current version + history
```

`compose` is silent and deterministic. It rewrites generated regions only if
their stored hash still matches, so hand edits inside generated sections are
refused. `bump` increments the version, refreshes the date, and prepends a
revision-history entry inside the same file. Relay its `DOC UPDATED …` line as
your proof the version actually moved — never claim you updated a doc without it.

**3a. Master docs: plan changes go into trip.db, never into the HTML.** When the
group changes route/nights/stays/itinerary/bookings, update `trip.db` with the
trip-planning / trip-core CLIs, then `compose`. Authored narrative goes in
`blocks/<slug>/*.html` (`intro`, `options`, `sights`, `food`, `weather`,
`packing`, `references`). Hand-writing a route table, stay row, or day card into
the master HTML is always wrong — compose will refuse the next run and the edit
will be lost. Use `compose --hosted` only for the copy you hand to
`artifact-deploy` (it adds the live Leaflet map); recompose without the flag
afterwards so the workspace copy stays the local variant. `compose --rebuild`
recovers a damaged or outdated shell without losing version history.

**4. Editing/composing is silent — sending or deploying is the exception.** Do
**not** re-attach the PDF or update the hosted page on every change. Send/deploy
only when:

- someone **explicitly asks** for it ("send the doc", "latest version", "update
  the page"), or
- the plan changed **significantly** and you ask whether they want the PDF/page
  refreshed.

When you do send, **render the PDF first and attach that** — never the `.html`:

```bash
$TD render <slug>     # writes <slug>.pdf from the canonical HTML; attach this file
```

For **minor** changes (wording, a single fact, a typo): just say what changed in
one line of text. Don't bump the version, don't render, and don't attach the file.
If you're unsure whether a change is significant enough to send, **ask** "Want the
updated file?" instead of auto-sending.

For hosted page updates, use the generic `artifact-deploy` skill. Trip-docs
does not own Netlify credentials or deployment. Do not deploy to save Netlify
free usage unless the user explicitly asks; after deploy, reply in WhatsApp with
the running URL and version.

**5. When you do send, make the trail legible.** Lead with one line of *what
changed since the last version*, and refer to the document by a stable, versioned
title (`Scotland Research v4`) — never label two sends the same way. The reader
should be able to tell, from the message alone, that this is the same document,
which version it is, and what moved.

Full command reference and the what-goes-where table are in this skill's
`SKILL.md`.
