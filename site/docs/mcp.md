---
layout: default
title: MCP interface
permalink: /docs/mcp/
---

Gate runs the same application services over stdio for any MCP client, backed by the same SQLite database as the web UI. The tool surface has no provider-specific behavior in it, so any MCP-capable agent connects the same way.

Two roles are easy to conflate, and they are now clearly different sets:

- An **MCP client** is an agent that connects *to* Gate and calls its tools — to read a timeline, submit evidence, or record a decision. Any MCP-capable agent can be one.
- A **provider** is the adapter Gate schedules to *run* a step, chosen per project by `providerKind`. Six ship; see [Provider adapters]({% link docs/providers.md %}).

They are independent. A project can be driven from Claude Code as the client while `codex` runs its steps, and nothing about the tool surface changes either way. The sections below register Gate as a server with each CLI that can act as a client.

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

## Connect the other CLIs

Each of the four newer CLIs can also act as an MCP client. The commands below are the vendor-documented registration forms; the argument shapes genuinely differ, so they are not variations on one pattern. Run them from the Gate repository root, because `node server/mcp/stdio.js` is a path relative to where Gate lives on disk.

```bash
# Codex — `--` before the command is mandatory for a stdio server
codex mcp add gate -- node server/mcp/stdio.js

# Gemini CLI — stdio is the default transport; no `--` separator
gemini mcp add gate node server/mcp/stdio.js

# Copilot CLI — `--` separator, writes to ~/.copilot/mcp-config.json
copilot mcp add gate -- node server/mcp/stdio.js
```

Cursor has no `mcp add` subcommand. Registration is a file edit — `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "gate": {
      "command": "node",
      "args": ["server/mcp/stdio.js"]
    }
  }
}
```

Its `mcp` subcommands manage servers that are already configured this way: `cursor-agent mcp list`, `list-tools`, `enable`, `disable`, and `login`.

Scope defaults differ too. Gemini writes project scope by default (`-s user` for the user-wide file); Codex writes `~/.codex/config.toml` and can also be configured declaratively with an `[mcp_servers.gate]` table; Copilot writes user scope, with `.mcp.json` as its per-repository tier. Each CLI has its own `mcp list` for verification.

One thing to avoid: `codex mcp-server` makes Codex *itself* an MCP server, which is the opposite direction and not how you register Gate.

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

### GATE Memory

See [Project intelligence]({% link docs/project-intelligence.md %}) for what is indexed and how.

| Tool | Input | Description |
| --- | --- | --- |
| `memory_status` | `projectId` | Compare the indexed revision with the current repository SHA and read graph/search counts. |
| `memory_search` | `projectId`, `query`, optional `limit`, `type` | Combine exact structural matches with local FTS5 source retrieval and explain each match. |
| `memory_neighbors` | `projectId`, `nodeId`, optional `depth`, `edgeTypes[]` | Traverse a bounded neighborhood through selected `CONTAINS`, `IMPORTS`, and `REFERENCES` edges. |
| `memory_impact` | `projectId`, `query`, optional `limit` (≤ 25) | Return matching symbols/files, declaring files, transitive production dependents, tests, risk, and structural reasons. |
| `memory_explain` | `projectId`, `nodeId`, optional `query` | Explain why one node is relevant: what matched, which recorded edges connect it, and where the fact came from. |
| `memory_god_nodes` | `projectId`, optional `limit` (≤ 100), `edgeTypes[]` | Rank structurally central nodes by recorded in/out degree. |
| `memory_communities` | `projectId`, optional `limit`, `members`, `edgeTypes[]` | Group the graph into connected components over import and reference edges. |
| `memory_path` | `projectId`, `fromNodeId`, `toNodeId`, optional `maxHops` (≤ 6), `edgeTypes[]` | Find the shortest recorded edge path between two nodes, or report that none exists within the hop cap. |
| `memory_query` | `projectId`, `question` (≤ 2,000 chars), optional `budget` (256–32,000) | Answer a question from Memory. Every statement cites a repository location and only recorded edges are used. |
| `memory_refresh` | `projectId`, optional `force`, `idempotencyKey` | Idempotently build or incrementally refresh the local index. |
| `memory_context` | `projectId`, `goal`, optional `kind` (`context`, `planning`, or `execution`), `tokenBudget` (512–32,000), `idempotencyKey` | Idempotently compile and persist a token-budgeted context capsule. It requires current Memory, injects project instructions, and returns full commit, graph, file, and retrieval provenance. |

Graph analysis is computed from the persisted node and edge tables at request time — there is no second index and no stored centrality. Centrality and community detection analyze at most 5,000 nodes and report `truncated` beyond that. A Memory answer never infers a relationship the indexer did not record.

`memory_refresh` and `memory_context` are mutations and require `idempotencyKey`. Memory tools operate only on the connected local repository. Context compilation does not send source or instruction content to a provider.

### Feature planning

Durable Feature workspaces and grounded planning requests are described in [Project intelligence]({% link docs/project-intelligence.md %}).

| Tool | Input | Description |
| --- | --- | --- |
| `feature_list` | `projectId` | List durable feature workspaces for a project. |
| `feature_get` | `projectId`, `featureId` | Read one durable feature workspace. |
| `feature_create` | `projectId`, `title`, `intent`, `idempotencyKey` | Create a local feature workspace. |
| `feature_update` | `projectId`, `featureId`, `status`, `idempotencyKey` | Advance a feature through its explicit lifecycle. |
| `feature_plan` | `projectId`, `featureId`, optional `model`, `tokenBudget`, `idempotencyKey` | Compile current Memory context and propose a feature timeline. |
| `issue_plan` | `projectId`, `issueId`, optional `model`, `tokenBudget`, `idempotencyKey` | Convert a local issue into the same grounded planning flow. |
| `milestone_expand` | `projectId`, `milestoneId`, optional `model`, `tokenBudget`, `idempotencyKey` | Propose child steps for a milestone without altering the accepted timeline. |
| `planning_get` | `projectId`, `planningRequestId` | Inspect a proposed or accepted planning request: impact, context provenance, and the proposed draft. |
| `planning_check_staleness` | `projectId`, `planningRequestId` | Compare a plan against current repository state: `CURRENT`, `POSSIBLY_STALE` when the repository moved without touching the plan's grounding, or `STALE` when a grounding file changed. |
| `planning_reground` | `projectId`, `planningRequestId`, optional `model`, `tokenBudget`, `idempotencyKey` | Propose a fresh Memory-grounded plan for the same source, linked to the plan it supersedes. The original is never modified or discarded. |

Feature planning mutations require `idempotencyKey`. MCP cannot accept a proposal — there is deliberately no accept tool; acceptance exists only through the localhost human-facing interface (`POST .../planning/:requestId/accept`), which the server keeps on a loopback bind by default.

### Planning inbox

The inbox collects what is waiting on a human decision — see [Project intelligence]({% link docs/project-intelligence.md %}).

| Tool | Input | Description |
| --- | --- | --- |
| `inbox_list` | `projectId` | List drifted accepted plans, proposals awaiting acceptance, and failed runs with no follow-up issue. Items are derived from current records, never stored separately. |
| `inbox_dismiss` | `projectId`, `itemKey`, `idempotencyKey` | Record that one derived item needs no action. The planning request or run it came from is never modified. |

Dismissal is the only inbox mutation, and it is append-only. There is no inbox accept tool, for the same reason there is no approval tool.

Every tool above takes `idempotencyKey` for mutations (read tools take none).

## What is deliberately absent

There is no MCP approval tool. This is intentional: an agent can report evidence but cannot impersonate the human review gate — mutating calls are recorded under the `mcp:local` actor, and approval gates require a decision from a human actor. There are also no merge, push, or protected-branch mutation tools; those do not exist anywhere in Gate, over MCP or otherwise.

## Multi-provider note

The MCP server and its tool set are provider-agnostic already; nothing here assumes Claude specifically. Each project's `providerKind` decides which adapter in `server/adapters/providers/` drafts timelines and runs timeline steps — see [Provider adapters]({% link docs/providers.md %}). Connecting a different agent over MCP works today, and that same agent can be the one Gate schedules to execute a step once its `providerKind` is configured in the Settings page.