# Phase 5 Feature Planning Design

## Purpose

Phase 5 adds durable feature planning above timeline steps. A feature keeps its intent, lifecycle, Memory-grounded impact, planning context, proposed timeline, and accepted work associations together. Existing issues can enter the same pipeline, and accepted milestones can be expanded progressively without bypassing timeline review.

## Scope

This phase delivers:

- a first-class Feature domain object and top-level Features workspace;
- a normalized planning-request record for feature, issue, and milestone sources;
- Memory-grounded impact previews and planning context capsules;
- provider-generated timeline drafts that remain proposed until explicitly accepted;
- links from planning sources to accepted milestones, runs, evidence, and reviews;
- progressive expansion of one accepted milestone into proposed child steps;
- a `Plan Issue` action for local GATE issues;
- HTTP, MCP, WebUI, event, mirror, and targeted test coverage.

This phase does not add GitHub writes, prompt refinement, architecture decisions, cloud services, automatic approvals, merge/push behavior, or Phase 6 plan-staleness controls. It does not remove the existing goal-to-timeline flow.

## Data model

Migration `010-feature-planning.sql` adds:

### `features`

- `id` text UUID primary key;
- `project_id` foreign key with cascade delete;
- `title` and `intent`;
- `status`: `idea`, `planning`, `approved`, `in_progress`, `blocked`, `review`, `complete`, or `cancelled`;
- created and updated timestamps.

### `planning_requests`

- `id` text UUID primary key;
- `project_id` foreign key;
- `source_type`: `feature`, `issue`, or `milestone`;
- `source_id` as the source object's stable string identifier;
- normalized `goal`;
- `context_capsule_id` and `timeline_draft_id` foreign keys;
- persisted `impact_json` and `provenance_json`;
- `status`: `proposed` or `accepted`;
- created and accepted timestamps.

Only one proposed planning request may exist for a source at a time. A source may retain older accepted requests as history.

### `planning_request_nodes`

Links an accepted request to the timeline nodes it produced. The composite primary key prevents duplicate associations. This is the basis for feature and issue views of milestones, runs, evidence, and review state.

## Domain services

### `FeatureService`

Owns feature creation, reads, listing, and explicit lifecycle transitions. All mutations are idempotent and append events. Transitions follow the declared lifecycle; cancellation is terminal, and completed features cannot silently return to active work.

### `PlannerService`

Normalizes a feature, issue, or milestone into one planning request. It:

1. resolves and validates the source within the project;
2. requires current GATE Memory;
3. computes impact through `MemoryService.impact()`;
4. compiles a `planning` capsule through `ContextCompiler`;
5. passes the capsule—not the legacy unbounded digest—to the configured provider;
6. validates the returned graph with existing DAG, parent, gate, and protected-work rules;
7. stores the impact, capsule provenance, and proposed timeline draft;
8. leaves the current timeline unchanged until explicit acceptance.

Acceptance uses the existing timeline-draft acceptance boundary, then records the nodes produced by the request and advances a linked feature to `approved`. It does not approve any human gate.

## Provider context

The planning capsule is serialized into compact sections for project rules, selected files and excerpts, symbols, tests, and structural edges. The provider also receives the project stage and the source type. Raw repository dumps, secrets, ignored files, and unrelated prior transcripts are excluded.

The existing free-form timeline draft endpoint remains compatible and may continue using the project digest during this phase. Feature, issue, and milestone planning must use the Planner service and Context Compiler.

## Impact preview

Each proposed planning request persists the deterministic result used during planning:

- direct matches and declaring files;
- production dependents;
- affected tests;
- structural edges and explanations;
- risk level;
- repository and Memory revision.

The UI renders this before the user accepts the draft. The preview is evidence of grounding, not a guarantee that every eventual file is known.

## Progressive milestone expansion

An accepted milestone can request expansion. GATE compiles current context for that milestone and asks the provider for one milestone's child steps. The response must contain at least one step and may not modify existing nodes. GATE remaps generated identifiers, parents every new step to the selected milestone, preserves generated step dependencies and gates, and constructs a proposed full-timeline revision by combining them with the current graph.

The existing timeline remains unchanged until that revision is accepted. Locked, running, review, and approved nodes retain the existing protection enforced by `TimelineService.replaceDraft()`.

## HTTP and MCP

HTTP adds project-scoped feature CRUD, feature planning, planning-request read/accept, issue planning, and milestone expansion routes. Input validation uses the existing Zod/error-envelope conventions, and every mutation requires an idempotency key.

MCP exposes compact equivalents for listing/reading/creating/updating/planning features, planning an issue, reading a planning request, and expanding a milestone. Plan acceptance remains available only through the localhost human-facing HTTP/WebUI boundary. No MCP approval tool is added. No tool can merge, push, delete protected work, or mutate GitHub.

## WebUI

The sidebar gains `Features`. The workspace provides:

- feature list and creation;
- status and intent;
- a planning action;
- impact preview grouped by matches, dependents, and tests;
- context provenance and token counts;
- proposed timeline summary and explicit acceptance;
- accepted milestones plus related runs, evidence, and review state.

The Issues view gains `Plan Issue`. The Timeline view gains `Expand milestone` only for accepted, non-terminal milestones. Both actions open the same proposed-plan review representation used by Features.

## Events and mirror

New event types record feature creation/status, planning proposal/acceptance, and milestone expansion proposal. Event payloads carry identifiers and counts rather than source excerpts.

The `.gate/` mirror adds read-only `features.json` and planning linkage summaries. SQLite remains authoritative and `.gate/` changes are never imported.

## Failure handling

- Missing or stale Memory returns `MEMORY_STALE`; planning never refreshes implicitly.
- A missing or cross-project source returns the existing not-found envelope.
- A second proposed request for the same source returns a conflict with the existing request ID.
- Provider failure creates no planning request or partial draft.
- Invalid or unsafe provider output is rejected before persistence.
- Acceptance remains idempotent and cannot modify protected timeline nodes.

## Testing

Tests cover migrations, feature lifecycle and idempotency, source ownership, stale Memory rejection, impact/context provenance, provider request content, proposed-before-accepted behavior, node linkage, milestone expansion merge safety, issue planning, HTTP validation, MCP capability boundaries, mirror output, and WebUI module syntax. The full Node suite and lint must pass. Browser tests retain the known `C:\tmp\gate-browser-data` permission boundary and will not be elevated without explicit approval.
