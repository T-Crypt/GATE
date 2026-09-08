---
layout: page
title: Architecture
permalink: /docs/architecture/
---

## Process layout

One Node process composes Express, WebSocket replay, scheduling, the static UI, and the application services. A separate stdio entry point (`server/mcp/stdio.js`) exposes the same services over MCP. SQLite is the source of truth: commands validate input, append ordered events, and update projections in one transaction.

## Domain / adapter boundary

The domain owns DAG, gate, and branch rules. Adapters own Git, provider processes, HTTP, WebSocket, and MCP. This boundary lets future providers implement `start()` and `draftTimeline()` without changing timeline or safety policy.

## Execution flow

Execution flows from accepted timeline node to safety preflight, isolated worktree, provider stream, commit-bound evidence, and human decision. There is intentionally no merge or push path.

- Safety preflight refuses to start a run if the base checkout has uncommitted changes (`DIRTY_BASE_WORKTREE`) and never executes on protected branches.
- Each run gets its own linked worktree on branch `work/gate-<run-id>`, created from the base branch without checking it out or modifying it.
- Evidence submitted against a gate is bound to a commit SHA and file scope; when the branch moves or an in-scope file changes, the evidence goes stale (`STALE_EVIDENCE`).
- Approval gates require a human actor; an agent that tries to approve its own work is rejected.

## Repository mirror (`.gate/`)

`RepoMirrorService` writes a read-only projection of SQLite — `project.json`, `timeline.json`, `issues.json`, `notes.json`, plus rendered `MILESTONES.md` and `ISSUES.md` — into `<repo>/.gate/` on every relevant event (`project.*`, `timeline.*`, `issue.*`, `note.*`). The first time Gate connects a project, it appends a `.gate/` entry to the project's `.gitignore`, so the mirror stays out of commits by default and cloning someone's repository never silently exposes their local Gate state. Remove the ignore entry if you want the mirror to travel with the repo; nothing reads `.gate/` back — it is an export, not a second copy of state. Mirror writes are best-effort: a failed mirror write never breaks the command that triggered it.

## Drafting context (`project_digests`)

`project_digests` holds one row per project: a depth-capped file tree and the current milestone titles, refreshed whenever the project's Git history is synced. `timeline_draft` sends this instead of raw repository content, so drafting a new milestone starts the provider with cheap orientation rather than an unscoped exploration or a full-codebase paste.

## One answer for activity

The Activity view and the `activity_feed` MCP tool both read the same query — runs joined to the timeline node that started them, plus the `activity` table — so "what has this project's agent actually run" has one answer whether it is asked from the browser or from an MCP client.
