---
layout: default
title: Project intelligence
permalink: /docs/project-intelligence/
---

GATE Memory, the Context Compiler, and Feature workspaces build a local project-intelligence layer on top of the timeline. Everything is derived, stored in the same local SQLite database, and grounded in the repository rather than in model guesses.

## GATE Memory

GATE Memory incrementally indexes the connected repository into SQLite:

- a **file graph** covering every repository file, always available regardless of language;
- a **symbol and import graph** added for JavaScript-family source — declared functions, classes, and variables plus resolved local ESM/CommonJS imports and named-import references;
- a **full-text projection** (embedded FTS5) over searchable source content for local retrieval.

File containment is recorded with `filesystem` provenance; symbols, imports, and references are recorded with `static_parser` provenance tied to the indexed commit. Unsupported languages still participate through the file graph and full-text search.

Memory is served through the **Memory view** in the Workstation, the HTTP API under `/projects/:id/memory/*`, and the `memory_*` MCP tools. Indexing and search caps keep it bounded (per-file and total file limits, plus `.gateignore` and secret-path exclusions). A repository move outside Gate does not silently go stale: the index records the repository SHA it was built from, and anything that needs current Memory — context compilation or planning — rejects an out-of-date index.

## Deterministic impact analysis

Impact analysis walks the persisted containment/import/reference edges to distinguish declaring files, transitive production dependents, and affected tests, and reports a risk level plus structural reasons. It reports repository facts; model-inferred relationships are never persisted as graph edges.

Search blends exact structural matches with local FTS5 retrieval and explains each match's score and selection reason, so it is auditable rather than a black box. Bounded neighborhood traversal (`memory_neighbors`) follows selected `CONTAINS`, `IMPORTS`, and `REFERENCES` edges.

## Context Compiler

The **Context Compiler** turns the current Memory revision and managed project instructions into immutable, token-budgeted **context capsules**. Capsules come in three kinds — `context`, `planning`, and `execution` — and combine hybrid retrieval, structural impact, project rules (from managed `AGENTS.md` / `CLAUDE.md` instruction documents), selected source excerpts, tests, and symbols.

- **Token budgeting** — the requesting budget (512–32,000) is enforced by reducing excerpts and lower-priority selections until the capsule fits; if it still cannot, compilation fails rather than trimming required context.
- **Provenance** — each capsule records the repository SHA, Memory revision, graph node IDs, source and instruction files, retrieval scores, and a content hash.
- **Freshness** — compilation fails with `MEMORY_STALE` if the index is not current, and rechecks the revision before persisting. Compilation never refreshes implicitly; callers must intentionally refresh returning Memory first.
- **Local** — capsules are local SQLite records surfaced through the HTTP API, the Memory UI, and the idempotent `memory_context` MCP tool. Compilation never sends source or instruction content to a provider.

Plans for features, issues, and milestones are compiled as `planning` capsules and passed to the provider in place of the raw repository; the legacy free-form goal draft keeps using `project_digests`.

## Feature workspaces

A **Feature** is a durable object above the timeline that keeps an intent, a lifecycle, and its planning together:

- `idea` → `planning` → `approved` → `in_progress` → `blocked` → `review` → `complete`, with `cancelled` as a terminal state. Transitions follow the declared lifecycle; completed or cancelled features cannot silently return to active work.
- Features appear in a top-level **Features** workspace, and each one groups its planning requests, accepted milestones, and related runs, evidence, and reviews.

Local issues use the same planning path via a **Plan Issue** action, and a milestone can be expanded progressively without bypassing timeline review.

## Planning requests

Features, issues, and milestones are normalized into one **planning request** record with a source type, a goal, a compiled `planning` capsule, a persisted impact preview and provenance, and a proposed timeline draft. Only one proposed request may exist per source at a time.

The flow is strictly grounded:

1. resolve and validate the source within the project;
2. require current GATE Memory;
3. compute deterministic impact;
4. compile a token-budgeted `planning` capsule;
5. ask the configured provider to propose a timeline from the capsule;
6. validate the returned graph under the same DAG, parent, gate, and protected-work rules as any draft;
7. persist the impact, provenance, and **proposed** draft — the current timeline is left unchanged.

Every generated plan stays **proposed until accepted** from the localhost interface. Acceptance reuses the existing timeline-draft acceptance boundary, links the produced timeline nodes back to the feature or issue, and advances a linked feature to `approved`. It never approves a human gate. The MCP surface can propose and inspect plans (`feature_plan`, `issue_plan`, `milestone_expand`, `planning_get`) but deliberately has no accept tool.

## Milestone expansion

A milestone can request **expansion**: GATE compiles current context for that milestone and asks the provider for child steps under it. The response must contain at least one step; generated identifiers are remapped, every new step is parented to the selected milestone, existing nodes are never modified (a collision raises `EXPANSION_CONFLICT`), and the result is combined with the current graph into a **proposed full-timeline revision**. The live timeline is untouched until that revision is accepted, and locked, running, review, and approved nodes retain the same protection as any draft replacement.

## Mirror and events

The `.gate/` repository mirror grows `features.json` alongside `project.json`, `timeline.json`, `issues.json`, and `notes.json`, embedding each feature's planning-request linkage. The mirror stays a read-only export — nothing in Gate imports it back.

New event families trace the same work: `feature.created` / `feature.status.updated`, `planning.proposed` / `planning.accepted`, `milestone.expansion.proposed`, plus `memory.index.*` and `context.compiled` — see the [Event log]({% link docs/events.md %}).

## MCP and HTTP

The `memory_*` and feature/planning tools are listed in the [MCP interface]({% link docs/mcp.md %}). HTTP routes live under `/projects/:id/memory/*` (status, search, neighbors, impact, context, refresh), `/projects/:id/features*` (CRUD, plans), `/projects/:id/issues/:issueId/plan`, `/projects/:id/timeline/nodes/:milestoneId/expansions`, and `/projects/:id/planning/:requestId` (read + accept). Every mutation requires an idempotency key.

Boundaries that stay deliberate: Memory is local to the connected repository, context compilation never sends source content to a provider, and plan acceptance remains on the localhost human-facing interface (the server binds loopback by default, and no MCP accept tool exists).