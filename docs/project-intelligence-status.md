# Project intelligence implementation status

This document records the implementation boundary at the end of Phase 6. `AGENTS.md` remains the architecture specification; this is the concise description of what the application currently ships.

## Complete vertical slices

- Phase 1: project lifecycle stages and managed `AGENTS.md` / `CLAUDE.md` instruction blocks.
- Phase 2: SQLite-backed GATE Memory revisions, safe repository indexing, incremental file graph updates, status/search HTTP and MCP surfaces, and the Memory UI.
- Phase 3: a language-indexer contract; JavaScript-family symbols, local imports, and named references; local FTS5 semantic retrieval; explainable hybrid ranking; bounded graph neighborhoods; and deterministic structural impact with affected tests.
- Phase 4: persisted context, planning, and execution capsules; token budgeting; current-revision enforcement; project-rule injection; commit, node, file, instruction, and retrieval provenance; HTTP/MCP surfaces; and capsule inspection in the Memory UI.
- Phase 5: durable Feature workspaces; normalized feature, issue, and milestone planning requests; Memory-grounded impact previews and context; proposed-before-accepted timeline flow; progressive milestone expansion; HTTP/MCP surfaces; and read-only `.gate/features.json` export.

- Phase 6: graph-grounded Memory querying — node explanations, structural centrality, connected-component communities, bidirectional path finding, and a token-budgeted natural-language query — plus plan provenance comparison, live staleness classification, explicit re-grounding, and a pre-execution staleness warning.
- Phase 6 surface: the pre-execution warning renders as a persistent panel with a re-ground action, every `planningReview` call site passes staleness, the three staleness states carry distinct status colors, the Memory page leads with Ask and collapses its graph tools, and a derived Planning Inbox collects drifted plans, proposals awaiting acceptance, and failed runs with no follow-up.

## Current boundaries

- SQLite remains authoritative. Memory and context data are local derived/provenance records; no cloud dependency or embedding service is required.
- Static symbol/import indexing currently supports JavaScript-family source. Other text files still participate in the file graph and local full-text search.
- Structural impact reports repository facts from persisted containment/import/reference edges. It does not save model guesses as graph edges.
- Context compilation never refreshes implicitly: callers must intentionally refresh stale Memory, and compilation rechecks the revision before persistence.
- Feature, issue, and milestone plans use context capsules; the legacy free-form goal draft remains compatible with `project_digests`.
- Plan acceptance is localhost-only. MCP can propose, inspect, and re-ground plans but cannot accept them.
- Graph querying computes from the persisted `memory_nodes` and `memory_edges` tables at request time. There is no second index, no stored centrality, and no committed graph artifact. Centrality and community analysis load at most 5,000 nodes and report `truncated` beyond that.
- A Memory answer cites a repository location for every claim and only reports edges the indexer recorded. It never infers a relationship.
- Plan staleness is computed live from the plan's stored provenance against current HEAD; no cached status column exists. `STALE` means a grounding file changed, `POSSIBLY_STALE` means the repository moved without touching one.
- Re-grounding proposes a new plan linked by `supersedes_id`. It never modifies, supersedes in place, or discards an accepted plan, and a stale plan warns before execution rather than blocking it.
- Inbox items are derived at read time from `planning_requests` and `runs`; the only stored inbox state is a dismissal row keyed by the derived item key, so the inbox can never disagree with the records it describes. A stale plan that already has a re-grounded proposal drops out in favour of that proposal's item. A failed run's follow-up is derived from an issue tracking its branch. Drift is checked for at most the 25 most recently accepted plans per read, and a truncated sweep says so.
- Inbox actions route to existing services — `memory.impact`, `planner.reground`, `dashboard.addIssue` — and dismissal is idempotent and append-only. The inbox has no acceptance or approval action.
- The pre-execution staleness warning is session state on the Timeline page: it survives re-render and navigation until dismissed or re-grounded, and the Inbox is its durable home across restarts.
- MCP exposes evidence submission and inbox dismissal but still has no approval, merge, push, delete, or protected-branch mutation capability.

## Next clean boundary

Phase 7 begins above single-plan grounding: cross-plan and cross-feature dependency awareness, retention and compaction of Memory revisions and context capsules, and structural indexing for languages beyond the JavaScript family. Existing accepted work must never be discarded automatically. Inbox sources beyond the derived three — imported GitHub issues, memory suggestions, review findings (`AGENTS.md` §103) — belong to that phase; adding them must not introduce a second source of truth for items that already exist as records.

## Verification note

The Node unit/integration suite is the reliable automated boundary. On Linux the full `npm run check` gate, browser tests included, runs clean. On the Windows workstation browser tests remain blocked before launch because their fixture cannot recursively reset `C:\tmp\gate-browser-data`; do not bypass that filesystem permission boundary without explicit approval.
