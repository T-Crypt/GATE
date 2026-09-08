---
layout: page
title: Provider adapters
permalink: /docs/providers/
---

Claude is the first adapter (`server/adapters/providers/claude.js`). It invokes the local `claude` executable without a shell, uses streamed JSON output, bounds captured output (`GATE_OUTPUT_LIMIT_BYTES`, default 2 MB), redacts common secret patterns, and runs only in the assigned worktree.

## Provider contract

A provider implements two methods:

- `start(request, observer)` — run one timeline step; returns a cancellable session plus a completion promise
- `draftTimeline({ goal, repositoryContext, cwd, env })` — propose a dependency-aware timeline for a goal

Providers never own branch, timeline, gate, or approval policy — those live in the domain. Provider credentials remain in that provider's local environment; do not persist secrets in project configuration.

## Adding a provider

A new adapter ships by implementing the two methods above against the same request and observer shapes the Claude adapter uses — no changes to the domain, the HTTP API, or the MCP tool surface are required. The [MCP interface]({% link docs/mcp.md %}) already works for any connected agent; what is provider-specific today is only which executable Gate schedules when a step starts.
