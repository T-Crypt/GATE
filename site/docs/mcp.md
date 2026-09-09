---
layout: default
title: MCP interface
permalink: /docs/mcp/
---

Gate runs the same application services over stdio for any MCP client, backed by the same SQLite database as the web UI. Today those clients are Claude Code and OpenCode; the tool surface has no provider-specific behavior in it, so any MCP-capable agent can connect the same way.

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

Then ask the agent to list Gate projects (`project_list`) to confirm it can reach the server. The server identifies itself as `gate-mcp`; Claude Code surfaces its tools under that prefix (`mcp__gate-mcp__project_list` and so on). `npm run mcp` starts the same stdio server directly, which is useful for testing outside Claude Code.

## Connect OpenCode

From the Gate repository root:

```bash
opencode mcp add gate -- node server/mcp/stdio.js
```

OpenCode surfaces the tools under the server-name prefix (`gate-mcp_project_list` and so on). The register/verify/reload flow matches Claude Code: confirm with `opencode mcp list`, list Gate projects with `project_list`, and restart OpenCode after adding the server or a skill.

## The Gate skill

Registering the server tells an agent *what it can do*; the skill tells it *how to work the board* — use the Gate MCP tools for every read and write rather than the CLI or hand-editing `.gate/`, keep timelines dependency-aware, submit commit-bound evidence to gates, and never attempt to approve its own work. Gate ships two equivalent skills in the [Gate repository](https://github.com/T-Crypt/GATE): `.claude/skills/gate/SKILL.md` for Claude Code and `.opencode/skills/gate/SKILL.md` for OpenCode. Copy the one that matches your connected agent into that project and trim rules that don't apply there:

```bash
mkdir -p .claude/skills/gate
curl -fsSL https://raw.githubusercontent.com/T-Crypt/GATE/main/.claude/skills/gate/SKILL.md \
  -o .claude/skills/gate/SKILL.md

mkdir -p .opencode/skills/gate
curl -fsSL https://raw.githubusercontent.com/T-Crypt/GATE/main/.opencode/skills/gate/SKILL.md \
  -o .opencode/skills/gate/SKILL.md
```

Both the MCP server and skills load at startup, so restart the agent after adding either.

## Tool reference

Every mutating tool requires an `idempotencyKey` (1–200 characters); retrying with the same key returns the original result instead of repeating the command. Read tools take no key. Mutating calls are recorded in the event log under the actor `mcp:local`, never as a human.

Errors come back as `{ "error": { "code", "message" } }`, using the same codes as the HTTP API — see [Troubleshooting]({% link docs/troubleshooting.md %}).

### Read tools

| Tool | Input | Description |
| --- | --- | --- |
| `project_list` | — | List local Gate projects and their safety policy. |
| `timeline_get` | `projectId` | Read timeline nodes, dependency edges, and gates for a project. |
| `run_get` | `runId` (UUID) | Read one run: branch, worktree, provider, status. |
| `review_get` | `projectId` | Read gates, evidence, approvals, and recent runs for human review. |
| `activity_feed` | `projectId`, optional `limit` (≤ 200) | Read recent timeline-driven runs and activity for a project, newest first. |

### Timeline tools

| Tool | Input | Description |
| --- | --- | --- |
| `timeline_draft` | `projectId`, `goal` (3–20,000 chars) | Ask the configured provider to propose a timeline from a goal, without applying it. |
| `timeline_accept_draft` | `projectId`, `draftId` (UUID) | Accept one validated proposed timeline draft. |
| `timeline_replace_draft` | `projectId`, `graph { nodes ≤ 2000, edges ≤ 5000, gates ≤ 5000 }` | Validate and replace editable timeline content while preserving protected (already-run) work. |

### Execution tools

| Tool | Input | Description |
| --- | --- | --- |
| `step_start` | `projectId`, `nodeId` | Start one ready timeline step in its isolated run worktree. |
| `step_schedule` | `projectId` | Start the next dependency-ready step, when the project's interaction level allows it. |
| `step_cancel` | `runId` (UUID) | Cancel an active provider run without deleting its worktree. |

### Evidence and issues

| Tool | Input | Description |
| --- | --- | --- |
| `gate_submit_evidence` | `projectId`, `gateId`, `kind`, `headSha`, `fileScope[]` (≤ 250 paths), optional `command`, `exitCode`, `output` (≤ 100,000 chars), `artifactPath` | Attach commit-bound local evidence — test output, build result, screenshot path — to a gate. |
| `issue_create` | `projectId`, `title` (≤ 500 chars), optional `branch`, `kind` (`bug`, `feature`, or `task`) | Create a local issue, bug report, or feature request. |
| `issue_update` | `projectId`, `issueId`, `status` (`open`, `in_progress`, or `closed`) | Change an issue's status. |
| `note_create` | `projectId`, `body` (≤ 10,000 chars), optional `tags[]` (≤ 30 tags) | Record a local project note, optionally tagged. |

Every tool above takes `idempotencyKey` for mutations (read tools take none).

## What is deliberately absent

There is no MCP approval tool. This is intentional: an agent can report evidence but cannot impersonate the human review gate — mutating calls are recorded under the `mcp:local` actor, and approval gates require a decision from a human actor. There are also no merge, push, or protected-branch mutation tools; those do not exist anywhere in Gate, over MCP or otherwise.

## Multi-provider note

The MCP server and its tool set are provider-agnostic already; nothing here assumes Claude specifically. Each project's `providerKind` decides which adapter (`server/adapters/providers/claude.js` or `opencode.js`) drafts timelines and runs timeline steps — see [Provider adapters]({% link docs/providers.md %}). Connecting a different agent over MCP works today, and that same agent can be the one Gate schedules to execute a step once its `providerKind` is configured in the Settings page.