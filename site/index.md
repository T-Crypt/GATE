---
layout: default
title: Gate
home: true
description: Gate — a localhost-first control plane for human-reviewed AI development.
---

<p class="lede">A localhost-first control plane for human-reviewed AI development. You describe a goal in plain language, an agent proposes a dependency-aware timeline of milestones and steps, you review and accept it, and only then does anything run. Every run happens in its own isolated Git worktree and stops at the first unmet dependency or unapproved gate.</p>

<div class="actions" role="group" aria-label="Primary actions">
  <a href="{{ site.baseurl }}/docs/setup/">Read the docs</a>
  <a href="https://github.com/T-Crypt/GATE" target="_blank" rel="noopener">Source</a>
</div>

## What it does

- **Plans before it acts.** You give Gate a goal and repository context. The provider returns a graph of milestones and steps with explicit dependencies and gates — not a wall of text. Nothing executes until you accept the draft.
- **Runs in isolation.** Every accepted step gets its own linked worktree on a branch named with the project's run-branch prefix (`work/gate-<run-id>` by default, per-project configurable), created from your base branch without checking it out or modifying it. Gate refuses to start a run if that base checkout has uncommitted changes.
- **Never touches your protected branches.** Connect auto-detects the repository's default branch as the single protected base; optional stable and production branches can be added from Settings. Gate will not execute, merge, push, delete, or rewrite protected branches. There is no merge or integration command anywhere in the app — a human reviews the resulting branch and decides what happens to it, outside Gate entirely.
- **Shows the remote picture without writing to it.** With `GATE_GITHUB_TOKEN` set, the Git view observes open pull requests and repository issues over the GitHub API — read-only. Gate never creates, merges, or pushes a branch on your behalf.
- **Ties evidence to a commit.** Evidence submitted against a gate is bound to a specific commit SHA and file scope. If the branch moves or a file in that scope changes afterward, the evidence goes stale and can no longer satisfy the gate. Approval gates require a decision from a human actor; Gate rejects an agent that tries to approve its own work.
- **Records every command as an event.** Each command appends an ordered, immutable event and updates its read model in one transaction. That event stream also drives the live UI over WebSocket. A client that drops and reconnects gets replayed exactly the events it missed — no gaps or duplicates.
- **Shows you the whole plan at once.** The timeline view renders a mile-marker rail across the top: one colored badge per milestone connected by a track, showing which milestones are gating which. Each milestone's lane carries the same color as its marker, so overview and detail stay visually tied.
- **Keeps a copy in your repo.** Gate mirrors each project's timeline, issues, notes, and features into `<repo>/.gate/` as plain JSON and Markdown, refreshed on every change. The mirror is ignored by default — Gate appends a `.gate/` entry to the project's `.gitignore` on first connect — but remove that entry and the data travels with the repo.
- **Builds local project intelligence.** GATE Memory incrementally indexes repository files, JavaScript-family symbols, imports, references, and searchable source text into SQLite. Its Memory view supports hybrid search, focused graph traversal, and deterministic impact analysis. The Context Compiler turns those results and project instructions into token-budgeted planning or execution capsules with commit- and node-level provenance; stale indexes are rejected rather than silently used.
- **Answers questions about the codebase.** Memory answers structural questions straight from the recorded graph — why a node matters, which nodes are structurally central, how the repository groups into communities, the shortest path between two nodes, and a token-budgeted natural-language answer where every statement cites a repository location. Nothing is inferred that the indexer did not record.
- **Tells you when a plan has drifted.** An accepted plan is grounded in a commit. Gate compares that grounding against current `HEAD` and classifies it `CURRENT`, `POSSIBLY_STALE`, or `STALE`, naming the grounding files that changed. Starting a step against a drifted plan warns you and keeps the warning on screen; it never blocks the run and never rewrites approved work. Re-grounding proposes a fresh plan linked to the one it supersedes.
- **Collects what needs you in one place.** The Planning inbox lists drifted plans, proposals awaiting acceptance, and failed runs with no follow-up issue, with Analyze, Re-ground, Convert to issue, and Dismiss. Items are derived from existing records rather than stored twice, so the inbox cannot disagree with the timeline.
- **Keeps feature work grounded.** Durable Feature workspaces connect intent, structural impact, compiled context, and proposed timeline revisions. Local issues use the same planning path, while milestones can be expanded progressively. Every generated plan stays proposed until it is accepted from the localhost interface.
- **Speaks MCP too.** The same application services run over stdio for any MCP client. An agent can report evidence, but it cannot approve its own gate — there is deliberately no approval tool over MCP.

## Safety contract

- Binds to `127.0.0.1` by default. No telemetry, no cloud service.
- Never executes on, merges into, pushes, deletes, or rewrites protected branches — the connected default branch, plus any stable/production branches you add in Settings. Remote observation is strictly read-only.
- Agents submit evidence. Only a human actor can approve a gate.
- Every automatic run gets its own branch in a linked worktree, never the base checkout.
- Validation artifacts live under `data/tests/<project-id>/` and stay local.

## Quick start

Requirements: Node.js 24+, Git, and a provider CLI authenticated locally.

```bash
npm ci
npm start
```

Open `http://127.0.0.1:4177`, connect an existing Git repository, describe a goal, review the proposed timeline, then accept it. Automatic mode starts ready steps on its own but always stops at unmet dependencies and human gates.

## Documentation

- [Setup & Operations]({{ site.baseurl }}/docs/setup/) — requirements, npm scripts, environment variables, data layout, backups
- [Architecture]({{ site.baseurl }}/docs/architecture/) — process layout, domain/adapter boundary, execution flow
- [Project intelligence]({{ site.baseurl }}/docs/project-intelligence/) — GATE Memory, the Context Compiler, and feature planning
- [Provider adapters]({{ site.baseurl }}/docs/providers/) — the Claude and OpenCode adapters and the provider contract
- [MCP interface]({{ site.baseurl }}/docs/mcp/) — tools, idempotency keys, and what is deliberately absent
- [Event log]({{ site.baseurl }}/docs/events/) — append-only events, replay, and event families
- [Troubleshooting]({{ site.baseurl }}/docs/troubleshooting/) — health endpoints, error codes, and recovery

## Source

Gate is open source: [github.com/T-Crypt/GATE](https://github.com/T-Crypt/GATE). Run `npm run dev` for development; `npm run check` is the full release gate (lint, unit, integration, and browser tests).