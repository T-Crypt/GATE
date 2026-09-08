---
layout: page
title: Provider adapters
permalink: /docs/providers/
---

Claude is the first adapter. It invokes the local `claude` executable without a shell, uses streamed JSON output, bounds captured output, redacts common secret patterns, and runs only in the assigned worktree.

A future provider implements the same contract:

- `start(request, observer)` — returns a cancellable session plus a completion promise
- `draftTimeline({ goal, repositoryContext, cwd, env })` — proposes a dependency-aware timeline

Providers never own branch, timeline, gate, or approval policy. Provider credentials remain in that provider's local environment; do not persist secrets in project configuration.
