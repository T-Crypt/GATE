# Provider adapters

Claude is the first adapter. It invokes the local `claude` executable without a shell, uses streamed JSON output, bounds captured output, redacts common secret patterns, and runs only in the assigned worktree.

A future provider implements the same `start(request, observer)` and `draftTimeline({ goal, repositoryContext, cwd, env })` contract, returns a cancellable session plus completion promise, and never owns branch, timeline, gate, or approval policy. Provider credentials remain in that provider's local environment; do not persist secrets in project configuration.
