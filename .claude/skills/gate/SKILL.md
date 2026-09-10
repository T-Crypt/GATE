---
name: gate
description: Workflow rules for working with the Gate control plane — use the Gate MCP tools for every read and write, keep timelines dependency-aware, submit commit-bound evidence to gates, and never try to approve your own work.
---

# Gate workflow

- **Use the Gate MCP tools for every Gate operation.** The tool names match the [MCP reference](https://t-crypt.github.io/GATE/docs/mcp/) — in Claude Code they may surface prefixed with the server name (`mcp__gate-mcp__*`).
- **Never hand-edit the `.gate/` mirror.** `project.json`, `timeline.json`, `issues.json`, `notes.json`, `MILESTONES.md`, and `ISSUES.md` are regenerated from the database on every change — an edit made by hand is lost on the next write. Use the tools (or the web UI); the mirror is a read-only orientation snapshot.
- **Orient cheaply before acting.** Read the `.gate/` mirror or `project_list` and `timeline_get` first to learn the project id, base branch, safety policy, milestones, and where the dependency edges point. It is always fine to start a session that way.
- **Plan before anything runs.** Ask the human for a goal, then call `timeline_draft` to get a proposed dependency-aware timeline — do not invent or apply one silently. Show the draft and wait.
- **Only a human accepts a timeline.** `timeline_accept_draft` applies a draft. Never accept a draft, and never ask the provider to, on the human's behalf — drafting and deciding are separate steps for a reason.
- **Run steps only through Gate, never around it.** Start ready steps with `step_start`, or let automatic mode advance with `step_schedule` when the project's interaction level allows it. Every run happens in its own linked worktree on a branch using the project's run-branch prefix (default `work/gate-<run-id>`); never start work on the project's protected branches (the connected default branch, plus any stable or production branches configured in Settings), and never manipulate them.
- **Stop at unmet dependencies and human gates.** If a step is blocked upstream, report it and wait — do not skip the gate or reorder the graph to dodge it.
- **Submit evidence, never claims.** Every completed gate needs `gate_submit_evidence` with a commit-bound `headSha`, the `fileScope` the work touched, a `kind`, and the result (`command`, `exitCode`, `output`, or `artifactPath`). Evidence goes stale when the branch moves or a scoped file changes; if it does, resubmit or say so.
- **Never approve your own gates — there is no approval tool.** Gate deliberately exposes no decision tool over MCP, and approval gates require a human actor. If a gate needs a decision, send the human the `review_get` bundle and wait.
- **Every mutation takes an `idempotencyKey`.** Retrying the same key returns the original result instead of repeating the command, so reusing a key is the safe way to retry after an unclear failure. Read tools take no key.
- **Gate never merges or pushes.** There is no integration path anywhere in Gate: the human reviews the resulting branch and decides what happens to it, outside Gate. Keep the work on its run branch and present it.
- **Track work as issues and notes.** File and move issues through `issue_create` / `issue_update` (pass `branch` so the issue follows its branch), record context with `note_create`, and keep statuses current as things land.
- **Verify before claiming success.** Confirm what actually ran with `activity_feed` (or `run_get` for a specific run) rather than assuming a step's gates passed. "What has this project's agent actually run" has one answer — read it from there.
- **Be concise.** Milestones, steps, issues, and comments should be scannable, not essays. The human reviews this surface.