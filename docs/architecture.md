# Architecture

One Node process composes Express, WebSocket replay, scheduling, static UI, and application services. A separate stdio entry point exposes the same services over MCP. SQLite is the source of truth: commands validate input, append ordered events, and update projections in one transaction.

The domain owns DAG, gate, and branch rules. Adapters own Git, provider processes, HTTP, WebSocket, and MCP. This boundary lets future providers implement `start()` and `draftTimeline()` without changing timeline or safety policy.

Execution flows from accepted timeline node to safety preflight, isolated worktree, provider stream, commit-bound evidence, and human decision. There is intentionally no merge or push path.
