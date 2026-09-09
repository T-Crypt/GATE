# MCP interface

Gate runs the same application services over stdio for any MCP client. Today that client is Claude Code; the tool surface has no Claude-specific behavior in it, so any MCP-capable agent can connect the same way once it exists.

## Connect Claude Code

From the Gate repository root:

```bash
claude mcp add gate -- node server/mcp/stdio.js
```

This registers Gate at `local` scope (the default): private to you, scoped to whichever project directory you run the command from. Run it again from a different project's own working directory if you want Gate connected there too — the MCP server itself is stateless per connection and reads whichever Gate project you point it at via `projectId`.

Other scopes:

```bash
# Available in every project for your user account
claude mcp add --scope user gate -- node server/mcp/stdio.js

# Shared with collaborators via .mcp.json committed to the repo
claude mcp add --scope project gate -- node server/mcp/stdio.js
```

Project scope isn't recommended here: `node server/mcp/stdio.js` is a path relative to wherever Gate itself lives on disk, not the project you're working in, so a committed `.mcp.json` would only work for people with Gate checked out at the same relative location.

Verify the connection:

```bash
claude mcp list
```

Then ask Claude to list Gate projects (`project_list`) to confirm it can reach the server. The server identifies itself as `gate-mcp`; Claude Code surfaces its tools under that prefix (`mcp__gate-mcp__project_list` and so on). `npm run mcp` also starts the same server directly, useful for testing outside Claude Code.

## The Gate skill

Registering the server tells an agent *what it can do*; the skill tells it *how to work the board* — use the Gate MCP tools for every read and write rather than the CLI or hand-editing `.gate/`, keep timelines dependency-aware, submit commit-bound evidence to gates, and never attempt to approve its own work. Gate's skill lives at [`.claude/skills/gate/SKILL.md`](../.claude/skills/gate/SKILL.md). Copy it into a connected project's `.claude/skills/` and trim rules that don't apply there:

```bash
mkdir -p .claude/skills/gate
cp /path/to/gate/.claude/skills/gate/SKILL.md .claude/skills/gate/SKILL.md
```

Both the MCP server and skills load at startup, so restart Claude Code after adding either.

## Tools

Every mutating tool requires an `idempotencyKey`; retrying the same key returns the original result instead of repeating the command. Read tools take no key.

**Projects**
- `project_list` — list local Gate projects and their safety policy.

**Timeline**
- `timeline_get` — read nodes, dependency edges, and gates for a project.
- `timeline_draft` — ask the configured provider to propose a timeline from a goal, without applying it.
- `timeline_accept_draft` — accept one proposed draft.
- `timeline_replace_draft` — validate and replace editable timeline content while preserving protected (already-run) work.

**Execution**
- `step_start` — start one ready timeline step in its isolated run worktree.
- `step_schedule` — start the next dependency-ready step, when the project's interaction level allows it.
- `step_cancel` — cancel an active run without deleting its worktree.
- `run_get` — read one run: branch, worktree, provider, status.
- `activity_feed` — read recent timeline-driven runs and activity for a project, newest first.

**Review and gates**
- `review_get` — read gates, evidence, approvals, and recent runs for human review.
- `gate_submit_evidence` — attach commit-bound evidence (test output, build result, screenshot path) to a gate.

**Issues and notes**
- `issue_create` — create a local issue. Pass `kind: "bug"` for a bug report or `kind: "feature"` for a feature request; omit it for a general task.
- `issue_update` — change an issue's status (`open`, `in_progress`, `closed`).
- `note_create` — record a local note, optionally tagged.

There is no MCP approval tool. This is intentional: an agent can report evidence but cannot impersonate the human review gate. There are also no merge, push, or protected-branch mutation tools — those don't exist anywhere in Gate, over MCP or otherwise.

## Multi-provider note

The MCP server and its tool set are provider-agnostic already; nothing here assumes Claude specifically. What's Claude-specific today is the *execution* adapter (`server/adapters/providers/claude.js`) that timeline steps actually run through — see [providers](providers.md). Connecting a different agent over MCP works today; having that same agent be the one Gate schedules to run a step is the part still gated on a second provider adapter shipping.
