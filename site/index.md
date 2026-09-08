---
layout: home
title: Gate
---

![Gate — a local control plane for human-reviewed AI development]({{ site.baseurl }}/assets/banner.svg)

Gate is a localhost-first control plane for human-reviewed AI development. You describe a goal in plain language, Claude proposes a dependency-aware timeline of milestones and steps, you review and accept it, and only then does anything run. Every run happens in its own isolated Git worktree and stops at the first unmet dependency or unapproved gate.

The name is literal. The core domain object is the **gate**: a checkpoint a step must clear (`code`, `test`, `build`, `plan`, `visual`, or `approval`) before the timeline lets it proceed. An agent can attach evidence to a gate. Only a human can decide it.

## What it does

- **Plans before it acts.** You give Gate a goal and repository context. Claude returns a graph of milestones and steps with explicit dependencies and gates, not a wall of text. Nothing executes until you accept the draft.
- **Runs in isolation.** Every accepted step gets its own linked worktree on a branch named `work/gate-<run-id>`, created from your base branch without ever checking it out or modifying it. Gate refuses to start a run if that base checkout has uncommitted changes.
- **Never touches your protected branches.** Base, stable, and production branches are configured once and locked. Gate will not execute on them, merge into them, push to them, delete them, or rewrite them. There's no merge or integration command anywhere in the app: a human reviews the resulting branch and decides what happens to it, outside Gate entirely.
- **Ties evidence to a commit.** Gate binds evidence submitted against a gate to a specific commit SHA and file scope. If the branch moves or a file in that scope changes afterward, the evidence goes stale and can no longer satisfy the gate. Approval gates require a decision from a human actor; Gate rejects an agent that tries to approve its own work.
- **Records every command as an event.** Each command appends an ordered, immutable event and updates its read model in one transaction. That event stream also drives the live UI over WebSocket. A client that drops and reconnects gets replayed exactly the events it missed, no gaps or duplicates.
- **Shows you the whole plan at once.** The timeline view renders a mile-marker rail across the top: one colored badge per milestone, connected by a track, showing which milestones are gating which. Each milestone's lane carries the same color as its marker, so the overview and the detail stay visually tied together.
- **Keeps a copy in your repo.** Gate mirrors each project's timeline, issues, and notes into `<repo>/.gate/` as plain JSON and Markdown, refreshed on every change. The mirror is ignored by default — Gate appends a `.gate/` entry to the project's `.gitignore` when it first connects — but remove that entry and the data travels with the repo instead of living only in Gate's local database.
- **Speaks MCP too.** The same application services run over stdio for any MCP client. An agent can report evidence, but it cannot approve its own gate — there is deliberately no approval tool over MCP.

## Safety contract

- Binds to `127.0.0.1` by default. No telemetry, no cloud service.
- Never executes on, merges into, pushes, deletes, or rewrites base, stable, or production branches.
- Agents submit evidence. Only a human actor can approve a gate.
- Every automatic run gets its own branch in a linked worktree, never the base checkout.
- Validation artifacts live under `data/tests/<project-id>/` and stay local.

## Quick start

Requirements: Node.js 24+, Git, and the Claude CLI authenticated locally.

```bash
npm ci
npm start
```

Open `http://127.0.0.1:4177`, connect an existing Git repository, describe a goal, review the proposed timeline, then accept it. Automatic mode starts ready steps on its own but always stops at unmet dependencies and human gates.

## Documentation

- [Setup & Operations]({{ site.baseurl }}/docs/setup/) — requirements, npm scripts, environment variables, data layout, and backups
- [Architecture]({{ site.baseurl }}/docs/architecture/) — process layout, domain/adapter boundary, execution flow
- [Provider adapters]({{ site.baseurl }}/docs/providers/) — the Claude adapter and the provider contract
- [MCP interface]({{ site.baseurl }}/docs/mcp/) — tools, idempotency keys, and what is deliberately absent
- [Event log]({{ site.baseurl }}/docs/events/) — append-only events, replay, and event families
- [Troubleshooting]({{ site.baseurl }}/docs/troubleshooting/) — error codes and recovery

## Source

Gate is open source: [github.com/T-Crypt/GATE](https://github.com/T-Crypt/GATE). Run `npm run dev` for development; `npm run check` is the full release gate (lint, unit, integration, and browser tests).
