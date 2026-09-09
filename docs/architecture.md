# Architecture

One Node process composes Express, WebSocket replay, scheduling, static UI, and application services. A separate stdio entry point exposes the same services over MCP. SQLite is the source of truth: commands validate input, append ordered events, and update projections in one transaction.

The domain owns DAG, gate, and branch rules. Adapters own Git, provider processes, HTTP, WebSocket, and MCP. This boundary lets future providers implement `start()` and `draftTimeline()` without changing timeline or safety policy.

Execution flows from accepted timeline node to safety preflight, isolated worktree, provider stream, commit-bound evidence, and human decision. There is intentionally no merge or push path.

`RepoMirrorService` writes a read-only projection of SQLite — timeline, issues, notes, as JSON and Markdown — into `<repo>/.gate/` on every relevant event, and `<repo>/.gitignore` gets a `.gate/` entry appended the first time Gate connects that project, so the mirror stays off by default in what a `git status` or a clone would show. Nothing reads `.gate/` back; it's an export, not a second copy of state.

`project_digests` holds one row per project: a depth-capped file tree and the current milestone titles, refreshed whenever the project's Git history is synced. `timeline_draft` sends this instead of raw repository content, so drafting a new milestone starts the provider with cheap orientation rather than an unscoped exploration or a full-codebase paste.

GATE Memory stores its derived project graph in SQLite. The file projection is extended by language indexers; the initial JavaScript-family adapter records declared functions, classes, and variables plus resolved local ESM/CommonJS imports. File containment uses `filesystem` provenance, while symbols, imports, and named-import references use `static_parser` provenance tied to the indexed commit. Unsupported languages remain available through the Level 1 file graph. Impact analysis walks incoming deterministic import/reference edges to distinguish declaring files, production dependents, and tests; it does not persist model-inferred relationships as facts.

The Activity view and the `activity_feed` MCP tool both read the same query — `runs` joined to the timeline node that started them, plus the `activity` table — so "what has this project's agent actually run" has one answer whether it's asked from the browser or from an MCP client.

## Remote observation

`RemoteService` caches a project's open pull requests and repository issues from the GitHub API (`remote_prs`, `remote_issues`). `remote.sync` is a single idempotent command that refetches both. The `GithubRemoteAdapter` is read-only: no create, merge, or push path exists, and without `GATE_GITHUB_TOKEN` the remote routes report `configured: false` and sync is rejected with `REMOTE_NOT_CONFIGURED`. Run branches take their prefix from the project's `branch_prefix` (default `work/gate-`).
