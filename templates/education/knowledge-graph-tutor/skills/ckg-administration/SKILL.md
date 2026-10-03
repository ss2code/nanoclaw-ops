---
name: ckg-administration
description: Inspect a concept knowledge graph, its concepts, prerequisite relationships, provenance, and revisions. Use when the authorized tutor asks to view or reason about the CKG or propose graph corrections.
---

Resolve context and require `role=tutor` for administrative changes. Use `ckg show --graph <slug> --json` for the committed graph. Treat `canonical_concept_id` as the cross-graph learning identity and source codes as display labels. When reviewing a graph for proactive learning, check that prerequisites form a navigable frontier, concepts have clear objectives, and the next concepts can support a short practice or retrieval task calibrated to the class audience profile. Review assessment revision lineage before interpreting item-level trends. Describe corrections as a new ingestion proposal; do not edit graph files or SQLite directly.
