---
layout: default
title: Architecture
permalink: /docs/architecture/
---

How Gate is composed: one Node process, an event-sourced SQLite core, and the hard boundary between domain rules and adapters.

## Process layout

One Node process composes Express, WebSocket replay, scheduling, the static UI, and the application services. A separate stdio entry point (`server/mcp/stdio.js`) exposes the same services over MCP. SQLite is the source of truth: commands validate input, append ordered immutable events, and update read model projections in one transaction. The event stream also drives the live WebSocket UI, which replays missed events to a reconnecting client.

## Domain / adapter boundary

- The **domain** owns DAG, gate, and branch rules — the safety policy.
- **Adapters** own Git, provider processes, HTTP, WebSocket, and MCP — the outside world.

This boundary is what lets a new provider ship as just `start()` and `draftTimeline()` (see [Provider adapters]({% link docs/providers.md %})) without touching timeline or safety policy.

## Execution flow

Execution flows from an accepted timeline node through four stages, with no merge or push path anywhere:

`node accepted → safety preflight → isolated worktree → provider stream → commit-bound evidence → human decision`

- **Safety preflight** refuses to start a run if the base checkout has uncommitted changes (`DIRTY_BASE_WORKTREE`) and never executes on protected branches.
- **Isolated worktree** — each run gets its own linked worktree on a branch named `<project-prefix><run-id>` — `work/gate-<run-id>` by default — created from the base branch without checking it out or modifying it.
- **Commit-bound evidence** — evidence submitted against a gate is bound to a commit SHA and file scope; when the branch moves or an in-scope file changes, the evidence goes stale (`STALE_EVIDENCE`).
- **Human decision** — approval gates require a human actor; an agent that tries to approve its own work is rejected.

## Run-branch handling

Gate uses the project's `branch_prefix` (default `work/gate-`) normalized without a forced trailing separator. Connect auto-detects the default branch via `POST /projects/inspect` (debounced in onboarding). Stable and production branch prompts were removed from onboarding but remain optional in Settings. Awaiting `remoteOrigin`/`defaultBranch` lookups in the Git adapter matters on Windows — an un-awaited child process keeps its working directory locked and breaks temp-dir cleanup.

## Remote observation (read-only)

When `GATE_GITHUB_TOKEN` is set, `RemoteService` (`server/application/remote-service.js`) observes the repository over the GitHub REST API and caches open pull requests and issues in `remote_prs` / `remote_issues`. The `GithubRemoteAdapter` (`server/adapters/remote/github.js`) only ever reads; `remote.sync` is a single idempotent command that refetches both and rewrites the cache. There is no create, merge, or push path — remote data is context, not control. Without a token, the remote routes report `configured: false` and sync is rejected with `REMOTE_NOT_CONFIGURED`.

## Repository mirror (`.gate/`)

`RepoMirrorService` writes a read-only projection of SQLite — `project.json`, `timeline.json`, `issues.json`, `notes.json`, plus rendered `MILESTONES.md` and `ISSUES.md` — into `<repo>/.gate/` on every relevant event (`project.*`, `timeline.*`, `issue.*`, `note.*`). The first time Gate connects a project it appends a `.gate/` entry to the project's `.gitignore`, so the mirror stays out of commits by default. Remove the ignore entry if you want the mirror to travel with the repo. Nothing reads `.gate/` back — it is an export, not a second copy of state, and a failed mirror write never breaks the command that triggered it.

## Drafting context (`project_digests`)

`project_digests` holds one row per project: a depth-capped file tree and the current milestone titles, refreshed whenever the project's Git history is synced. `timeline_draft` sends this instead of raw repository content, so drafting a new timeline starts the provider with cheap orientation rather than an unscoped exploration or a full-codebase paste.

## One answer for activity

The Activity view and the `activity_feed` MCP tool both read the same query — runs joined to the timeline node that started them, plus the `activity` table — so "what has this project's agent actually run" has one answer whether asked from the browser or an MCP client.