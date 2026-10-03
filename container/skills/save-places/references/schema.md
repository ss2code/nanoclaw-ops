# Save Places contracts

## Canonical store

`place-tracker/places.db` is the source of truth. Important tables:

- `regions`, `categories`, `places`, `place_aliases`
- `place_categories`, `place_tags`
- `sources`, `place_sources`, `place_evidence`, `media`
- `members`, immutable `activities`, projected `member_place_state`
- `external_mappings`, `ingest_runs`, `review_items`

The HTML and `places.json` files are replaceable projections. A future Notion
adapter should consume these normalized records and persist its remote IDs in
`external_mappings`; Notion synchronization is not implemented.

## Delegated research handoff

Errand Runner must not write its private `places.db` as the canonical result.
It writes a `save-places.research` handoff and sends that JSON file to the
owner agent with `send_file`. The owner ingests the attachment directly:

```bash
$PB handoff validate --json /workspace/inbox/<a2a-id>/save-places-handoff.json
$PB handoff materialize --json /workspace/inbox/<a2a-id>/save-places-handoff.json \
  --inbox /workspace/inbox/<a2a-id> --dir /workspace/agent/place-tracker \
  --out /tmp/save-places-handoff-ready.json   # only when artifacts exist
$PB ingest --json /workspace/inbox/<a2a-id>/save-places-handoff.json --reingest --publish-hub
```

With artifacts, ingest the materialized output instead. It verifies each
attachment checksum and rewrites local media paths into the persistent tracker
media directory before the transaction.

The handoff preserves the original channel message identity, member identity,
researching agent, evidence references, and optional artifact names. The
`--reingest` mode reconciles an already-completed key without creating a second
place, activity, evidence row, or media row; it is safe for retries after a
missing attachment or failed publication.

`verification.references` are persisted in `place_evidence` and exposed in
both the private and share projections. URLs remain clickable; non-URL notes
remain visible as text.

## Version-1 ingest envelope

```ts
{
  ingestVersion: 1;
  idempotencyKey: string;
  source?: {
    url?: string;
    platform?: string;
    title?: string;
    author?: string;
    sharedAt?: ISODate;
  };
  member: { localId: string; displayAlias: string };
  places: Array<{
    id?: string;
    name: string;
    aliases?: string[];
    address?: string;
    locality?: string;
    neighborhood?: string;
    coordinates?: { lat: number; lng: number };
    regionCandidate?: string;
    categories?: string[];
    tags?: string[];
    externalIds?: Record<string, string>;
    verification?: {
      state?: "verified" | "provisional" | "unverified";
      confidence?: number; // 0..1
      references?: string[];
    };
    activity?: {
      type?: string;
      interest?: "want-to-go" | "maybe" | "not-for-me";
      visitState?: "not-visited" | "visited" | "revisit";
      rating?: 1 | 2 | 3 | 4 | 5;
      comment?: string;
      visibility?: "group" | "shareable";
      occurredAt?: ISODate;
    };
    media?: Array<{
      kind: "remote-image" | "local-image" | "source-card";
      url?: string;
      localPath?: string;
      alt?: string;
      attribution?: string;
      visibility?: "group" | "shareable";
    }>;
    forceNew?: boolean;
  }>;
}
```

Constraints:

- 1–50 places per envelope; names are at most 200 characters.
- URLs must be HTTP(S) and have common tracking parameters removed.
- Coordinates must be valid.
- Confidence is 0–1.
- Rating is an integer 1–5 and requires a visited/revisit state.
- Reusing an idempotency key returns the original result without a second write.

## Published projection

Each regional tracker is a stable hub status document:

```text
trackers/shared/places-<region-id>/index.html
trackers/shared/places-<region-id>/data/places.json
```

`places.json` includes schema version, database revision, generated timestamp,
profile, region, place records, category counts, and aggregate summary.
