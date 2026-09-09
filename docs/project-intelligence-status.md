# Project intelligence implementation status

This document records the implementation boundary at the end of Phase 4. `AGENTS.md` remains the architecture specification; this is the concise description of what the application currently ships.

## Complete vertical slices

- Phase 1: project lifecycle stages and managed `AGENTS.md` / `CLAUDE.md` instruction blocks.
- Phase 2: SQLite-backed GATE Memory revisions, safe repository indexing, incremental file graph updates, status/search HTTP and MCP surfaces, and the Memory UI.
- Phase 3: a language-indexer contract; JavaScript-family symbols, local imports, and named references; local FTS5 semantic retrieval; explainable hybrid ranking; bounded graph neighborhoods; and deterministic structural impact with affected tests.
- Phase 4: persisted context, planning, and execution capsules; token budgeting; current-revision enforcement; project-rule injection; commit, node, file, instruction, and retrieval provenance; HTTP/MCP surfaces; and capsule inspection in the Memory UI.

## Current boundaries

- SQLite remains authoritative. Memory and context data are local derived/provenance records; no cloud dependency or embedding service is required.
- Static symbol/import indexing currently supports JavaScript-family source. Other text files still participate in the file graph and local full-text search.
- Structural impact reports repository facts from persisted containment/import/reference edges. It does not save model guesses as graph edges.
- Context compilation never refreshes implicitly: callers must intentionally refresh stale Memory, and compilation rechecks the revision before persistence.
- Context capsules are available building blocks but do not yet replace `project_digests` in provider timeline drafting.
- MCP exposes evidence submission but still has no approval, merge, push, delete, or protected-branch mutation capability.

## Next clean boundary

Phase 5 begins with a Feature domain object and memory-grounded feature planning. It should consume the Phase 4 capsule service rather than duplicating retrieval or sending an unbounded repository dump. Progressive milestone expansion, issue-to-timeline conversion, and a durable feature workspace remain future work.

## Verification note

The Node unit/integration suite is the reliable automated boundary on this workstation. Browser tests remain blocked before launch because their fixture cannot recursively reset `C:\tmp\gate-browser-data`; do not bypass that filesystem permission boundary without explicit approval.
