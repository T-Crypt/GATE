# Architecture

One Node process composes Express, WebSocket replay, scheduling, static UI, and application services. A separate stdio entry point exposes the same services over MCP. SQLite is the source of truth: commands validate input, append ordered events, and update projections in one transaction.

The domain owns DAG, gate, and branch rules. Adapters own Git, provider processes, HTTP, WebSocket, and MCP. This boundary lets future providers implement `start()` and `draftTimeline()` without changing timeline or safety policy.

Execution flows from accepted timeline node to safety preflight, isolated worktree, provider stream, commit-bound evidence, and human decision. There is intentionally no merge or push path.

`RepoMirrorService` writes a read-only projection of SQLite — timeline, issues, notes, as JSON and Markdown — into `<repo>/.gate/` on every relevant event, and `<repo>/.gitignore` gets a `.gate/` entry appended the first time Gate connects that project, so the mirror stays off by default in what a `git status` or a clone would show. Nothing reads `.gate/` back; it's an export, not a second copy of state.

`project_digests` holds one row per project: a depth-capped file tree and the current milestone titles, refreshed whenever the project's Git history is synced. `timeline_draft` sends this instead of raw repository content, so drafting a new milestone starts the provider with cheap orientation rather than an unscoped exploration or a full-codebase paste.

The Activity view and the `activity_feed` MCP tool both read the same query — `runs` joined to the timeline node that started them, plus the `activity` table — so "what has this project's agent actually run" has one answer whether it's asked from the browser or from an MCP client.
