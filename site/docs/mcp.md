---
layout: default
title: MCP interface
permalink: /docs/mcp/
---

Gate runs the same application services over stdio for any MCP client, backed by the same SQLite database as the web UI. Today that client is Claude Code; the tool surface has no Claude-specific behavior in it, so any MCP-capable agent can connect the same way once it exists.

## Connect Claude Code

From the Gate repository root:

```bash
claude mcp add gate -- node server/mcp/stdio.js
```

This registers Gate at `local` scope (the default): private to you and scoped to whichever project directory you run the command from. Run it again from a different working directory if you want Gate connected there too — each MCP session addresses a Gate project by `projectId`, so one server serves every local project.

Other scopes:

```bash
# Available in every project for your user account
claude mcp add --scope user gate -- node server/mcp/stdio.js

# Shared with collaborators via .mcp.json committed to the repo
claude mcp add --scope project gate -- node server/mcp/stdio.js
```

Project scope is not recommended here: `node server/mcp/stdio.js` is a path relative to wherever Gate itself lives on disk, not the repository you are working in, so a committed `.mcp.json` only works for people with Gate checked out at the same relative location.

Verify the connection:

```bash
claude mcp list
```

Then ask Claude to list Gate projects (`project_list`) to confirm it can reach the server. `npm run mcp` starts the same stdio server directly, which is useful for testing outside Claude Code.

## Tool reference

Every mutating tool requires an `idempotencyKey` (1–200 characters); retrying with the same key returns the original result instead of repeating the command. Read tools take no key. Mutating calls are recorded in the event log under the actor `mcp:local`, never as a human.

Errors come back as `{ "error": { "code", "message" } }` on an error response, using the same codes as the HTTP API — see [Troubleshooting]({% link docs/troubleshooting.md %}).

### Projects

| Tool | Kind | Input | Description |
| --- | --- | --- | --- |
| `project_list` | read | — | List local Gate projects and their safety policy. |

### Timeline

| Tool | Kind | Input | Description |
| --- | --- | --- | --- |
| `timeline_get` | read | `projectId` | Read timeline nodes, dependency edges, and gates for a project. |
| `timeline_draft` | mutation | `projectId`, `goal` (3–20,000 chars), `idempotencyKey` | Ask the configured provider to propose a timeline from a goal, without applying it. |
| `timeline_accept_draft` | mutation | `projectId`, `draftId` (UUID), `idempotencyKey` | Accept one validated proposed timeline draft. |
| `timeline_replace_draft` | mutation | `projectId`, `graph { nodes ≤ 2000, edges ≤ 5000, gates ≤ 5000 }`, `idempotencyKey` | Validate and replace editable timeline content while preserving protected (already-run) work. |

### Execution

| Tool | Kind | Input | Description |
| --- | --- | --- | --- |
| `step_start` | mutation | `projectId`, `nodeId`, `idempotencyKey` | Start one ready timeline step in its isolated run worktree. |
| `step_schedule` | mutation | `projectId`, `idempotencyKey` | Start the next dependency-ready step, when the project's interaction level allows it. |
| `step_cancel` | mutation | `runId` (UUID), `idempotencyKey` | Cancel an active provider run without deleting its worktree. |
| `run_get` | read | `runId` (UUID) | Read one run: branch, worktree, provider, status. |
| `activity_feed` | read | `projectId`, optional `limit` (≤ 200) | Read recent timeline-driven runs and activity for a project, newest first. |

### Review and gates

| Tool | Kind | Input | Description |
| --- | --- | --- | --- |
| `review_get` | read | `projectId` | Read gates, evidence, approvals, and recent runs for human review. |
| `gate_submit_evidence` | mutation | `projectId`, `gateId`, `kind`, `headSha`, `fileScope[]` (≤ 250 paths), optional `command`, `exitCode`, `output` (≤ 100,000 chars), `artifactPath`, `idempotencyKey` | Attach commit-bound local evidence — test output, build result, screenshot path — to a gate. |

### Issues and notes

| Tool | Kind | Input | Description |
| --- | --- | --- | --- |
| `issue_create` | mutation | `projectId`, `title` (≤ 500 chars), optional `branch`, `kind` (`bug`, `feature`, or `task`), `idempotencyKey` | Create a local issue, bug report, or feature request. |
| `issue_update` | mutation | `projectId`, `issueId`, `status` (`open`, `in_progress`, or `closed`), `idempotencyKey` | Change an issue's status. |
| `note_create` | mutation | `projectId`, `body` (≤ 10,000 chars), optional `tags[]` (≤ 30 tags), `idempotencyKey` | Record a local project note, optionally tagged. |

## What is deliberately absent

There is no MCP approval tool. This is intentional: an agent can report evidence but cannot impersonate the human review gate — mutating calls are recorded under the `mcp:local` actor, and approval gates require a decision from a human actor. There are also no merge, push, or protected-branch mutation tools; those do not exist anywhere in Gate, over MCP or otherwise.

## Multi-provider note

The MCP server and its tool set are provider-agnostic already; nothing here assumes Claude specifically. What is Claude-specific today is the *execution* adapter (`server/adapters/providers/claude.js`) that timeline steps actually run through — see [Provider adapters]({% link docs/providers.md %}). Connecting a different agent over MCP works today; having that same agent be the one Gate schedules to execute a step is the part still gated on a second provider adapter shipping.
