# Project MCP Localhost Developer Workstation Design

**Date:** 2026-09-07
**Status:** Approved design, pending implementation plan
**Target:** Localhost-first, single-user developer workstation

## Product intent

Project MCP is a local control plane for human-reviewed AI development. It joins project planning, Git activity, agent execution, evidence, approvals, and an interactive dependency timeline in one workstation.

Claude is the first execution provider. Provider-specific behavior remains behind an adapter so routers, local models, ensembles, and other agents can be added without changing timeline or gate logic.

The workstation may continue automatically through eligible work, but it must never merge into or directly modify `main`, a selected production branch, or a selected stable branch. A human always performs the final integration decision outside automatic execution.

## Experience direction

The interface combines a developer command center with a timeline studio.

- A persistent left navigation moves between Overview, Timeline, Agent, Issues, Git, Reviews, and Settings.
- The center workspace focuses on the active project, milestone, or review.
- A resizable right activity rail shows the live agent stream, current intent, evidence, decisions, and blockers.
- The timeline visualizes milestones, steps, dependencies, gates, active execution, and progress in real time.
- Review mode gathers diffs, test evidence, screenshots, decisions, and approval controls.
- A command palette supports keyboard-first navigation and common actions.

The visual system uses layered near-black glass surfaces, subtle blur, fine borders, rounded bezels, restrained cyan, violet, and green accents, compact typography, and high information density. It takes visual cues from the supplied reference without copying its assets or board layout.

The interface must include complete empty, loading, error, offline, reconnecting, blocked, and success states. Keyboard navigation, visible focus, reduced motion, responsive behavior, semantic structure, and accessible contrast are release requirements.

## System architecture

All clients use one command and policy layer.

```text
Web UI ---------+
Claude adapter -+--> Command API --> Validation and policy --> SQLite event log
MCP server -----+                              ^                    |
Git observer ----------------------------------+                    v
                                                        Projection engine
                                                               |
                                                        WebSocket events
                                                               |
                                                  Web UI and MCP subscribers
```

### Command layer

Commands express requested intent, including starting a step, requesting approval, recording gate evidence, cancelling a run, or changing a timeline dependency. Commands are authenticated as local actors, validated, authorized by project policy, and executed transactionally.

The Web UI, MCP server, provider adapters, and internal scheduler cannot write projection tables directly.

### Event log

The append-only event log is the canonical history. Each event includes:

- Event ID and monotonic project sequence
- Project and run identifiers
- Event type and schema version
- Actor type and actor identifier
- UTC timestamp
- Correlation and causation identifiers
- Validated JSON payload

Initial event families are `project.*`, `timeline.*`, `milestone.*`, `step.*`, `gate.*`, `approval.*`, `agent.*`, `git.*`, and `system.*`.

Events are immutable. Corrections are represented by later events. Writes to the event and its current-state projection occur in one SQLite transaction.

### Projections

Projection tables provide fast read views for projects, timeline nodes and edges, active runs, gate status, approvals, evidence, review queues, and activity feeds. A deterministic rebuild process can reconstruct projections from the event log.

Clients subscribe with a last-seen sequence. On reconnect they receive missed events before live delivery, preventing silent progress loss.

### Execution engine

The scheduler derives ready work from dependencies, gates, project policy, and current run state. Automatic mode starts eligible steps and continues until work completes, fails, is cancelled, or reaches a blocking gate.

Only one mutating run may own a project worktree at a time. Read-only analysis may run concurrently when a provider advertises that capability.

Startup recovery detects runs left in an active state. They become `interrupted` and require an explicit resume or cancellation decision unless the provider proves that its session is still attached.

### Provider contract

Providers implement:

- Capability discovery
- Configuration validation
- Start and resume
- Structured status and streamed output
- Graceful cancellation and forced termination
- Evidence and artifact reporting
- Health diagnostics

The Claude adapter is implemented first. Arbitrary shell command strings are not a provider interface. Provider configuration stores an executable plus validated arguments or a dedicated adapter configuration, and process launch does not use an interpolating shell.

### MCP interface

The MCP server wraps the same application services as HTTP and WebSocket clients. Initial tools cover:

- Project and timeline inspection
- Timeline node and dependency updates
- Step start, pause, cancel, and resume
- Gate declaration and evidence submission
- Approval requests and decisions
- Active-run status and activity
- Review bundle inspection

Every mutating MCP tool uses an idempotency key and returns the resulting project sequence. MCP cannot bypass branch protection, gate validation, or approval policy.

## Timeline model

The timeline is a directed acyclic graph rendered as milestone lanes and step nodes. A relationship such as “Milestone A, step 2 gates Milestone B, step 9” is an explicit dependency edge, not text metadata.

Nodes may represent milestones, executable steps, or gates. Gate types initially include:

- Code gate
- Test gate
- Build gate
- Plan gate
- Visual gate
- Human approval gate

Each gate declares whether it blocks downstream work, the evidence it requires, and who may satisfy it. Future gate types can be registered without changing the scheduler.

A step moves through:

```text
planned -> ready -> running -> review -> approved -> complete
                     |          |
                     v          v
                  blocked     rejected
                     |
                     v
             failed or cancelled
```

State transitions are enforced by policy. Progress is derived from completed requirements and provider activity; agents cannot submit arbitrary percentage values as authoritative completion.

## Git and branch safety

Each project selects:

- Repository path
- Base branch, defaulting to `main`
- Protected branches, always including the base branch plus any selected production or stable branch
- Worktree parent location

Starting an execution creates a dedicated branch named from the run identifier and a linked worktree based on the current selected base revision.

Before every mutating Git or process action, the backend resolves the actual repository, worktree, branch, and HEAD. The action is rejected if the branch is protected, the worktree is not the assigned run worktree, or the repository has changed outside the expected state.

Automatic execution cannot merge, rebase onto, force-update, delete, or push a protected branch. There is no UI or MCP override for this invariant. Changing the protected-branch configuration is a deliberate settings operation recorded in the event log and cannot affect an active run.

Completed work enters human review. The workstation can prepare a review bundle and safe copyable commands, but integration remains a manual action outside the automatic scheduler.

## Gates, evidence, and local validation

Every project receives a managed local validation area under the application data directory:

```text
tests/<project-id>/
  policy.json
  milestones/<milestone-id>/
    gates.json
    evidence/
```

This folder defines milestone gate criteria and retains local evidence without forcing files into the tracked repository. Approved artifacts may be exported into the repository through an explicit reviewed action.

The workstation may invoke repository-native tests and builds. Evidence records the command, sanitized environment summary, start and finish times, exit status, bounded output, artifact references, branch, and commit SHA.

Evidence becomes stale when its declared file scope changes or HEAD no longer matches the recorded commit. Stale evidence cannot satisfy a blocking gate.

Visual gates accept local screenshots and a human decision. Human approval gates require an explicit decision with an optional note. Agent assertions alone cannot satisfy visual or human gates.

## Interaction levels

Projects expose four policy presets:

1. **Observe:** inspect state and events only.
2. **Assist:** draft plans, milestones, dependencies, and gate suggestions for human acceptance.
3. **Automatic until blocked:** execute ready work and pause at blocking gates or failures.
4. **Custom:** configure individual capabilities while preserving hard branch and integration protections.

The selected level and every policy change are visible in the header and recorded as events.

## API behavior and errors

HTTP endpoints use versioned `/api/v1` routes and consistent JSON envelopes. Mutations accept idempotency keys. Validation errors identify fields; conflicts include current sequence and safe recovery instructions; unexpected errors return a correlation ID without exposing secrets or stack traces.

The WebSocket protocol includes versioned messages, project sequence, heartbeat, replay, and explicit resynchronization behavior. Slow subscribers are disconnected cleanly rather than consuming unbounded memory.

Provider output, event payloads, prompts, and artifact metadata have configurable size limits. Secret-like values are redacted before persistence and broadcast. Project paths are canonicalized and verified before use.

## Storage and operations

SQLite runs with foreign keys, WAL mode, busy timeout, prepared statements, and transactions. Ordered migrations replace startup-only schema creation. Database and event indexes cover project sequence, active runs, dependency lookups, gate status, and recent activity.

The server binds to loopback by default. Binding to another interface requires an explicit configuration change and startup warning. Health and readiness endpoints distinguish process health from database/provider readiness.

Graceful shutdown stops accepting work, marks or cancels owned processes according to policy, closes subscribers, checkpoints SQLite, and closes the database. Local backup and JSON export include schema versions and checksums.

Logs are structured and redact configured patterns. Retention limits bound provider output, activity detail, and artifacts while preserving compact event history.

## Testing strategy

The release requires:

- Unit tests for commands, transition rules, dependency readiness, evidence staleness, branch protection, redaction, and provider contracts
- Database tests for migrations, constraints, transactions, projection rebuilds, and sequence ordering
- API contract tests for validation, idempotency, conflicts, and error envelopes
- Integration tests using temporary Git repositories and linked worktrees
- Provider adapter tests using a deterministic fake executable
- WebSocket tests for replay, reconnect, heartbeat, and backpressure
- MCP protocol and policy-equivalence tests
- Browser tests for onboarding, timeline interaction, automatic execution, blocked gates, evidence review, responsive layout, keyboard access, and reconnect behavior
- Security tests for shell injection, path confusion, oversized payloads, invalid event transitions, and protected-branch attempts

Behavior changes follow test-driven development. A failing test must prove each new rule before production code is added.

## Developer experience

The repository will include:

- A single documented setup command and separate development and production starts
- Seeded demo data that cannot affect real repositories
- Formatting, linting, unit, integration, and browser-test scripts
- Environment schema with safe defaults and an example file containing no secrets
- Architecture, event catalog, MCP tool, provider adapter, and troubleshooting documentation
- Reusable test fixtures for temporary repositories, providers, timelines, and event streams

Modules remain small and interface-driven: domain policy, persistence, projections, Git/worktree operations, provider adapters, MCP transport, HTTP transport, WebSocket delivery, and frontend views are separate boundaries.

## First-release boundary

The first release delivers the complete local workflow from project onboarding through timeline planning, gated Claude execution, live progress, evidence review, and human handoff.

It does not poll external infrastructure, integrate with hosted issue trackers, support multiple users, execute automatic merges, or make deployment claims beyond a localhost workstation. Those capabilities may later enter through adapters and typed events.

## Acceptance criteria

The release is acceptable when a user can:

1. Add a local Git project and select base, production, and stable branch protections.
2. Create or accept a milestone graph with typed dependency and gate edges.
3. Start automatic execution and observe live Claude activity attached to the responsible timeline step.
4. See downstream steps remain blocked by code, test, visual, or approval gates.
5. Restart the workstation and recover an accurate, auditable run state.
6. Use MCP to inspect and update the same state without bypassing Web UI policies.
7. Review diffs and fresh evidence from the isolated worktree.
8. Finish with a review bundle while the protected branches remain unchanged.
