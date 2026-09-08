# Project MCP

Project MCP is a localhost-first control plane for human-reviewed AI development. It turns goals into dependency timelines, runs Claude inside isolated Git worktrees, streams progress to a black-glass Web UI, and records every command in SQLite plus an immutable event log.

## Safety contract

- Binds to `127.0.0.1` by default; there is no telemetry or cloud service.
- Never executes on, merges into, pushes, deletes, or rewrites base, stable, or production branches.
- Agents may submit evidence. Only a human actor can approve a gate.
- Every automatic run gets `work/pmcp-<run-id>` in a linked worktree.
- Validation artifacts belong under `data/tests/<project-id>/` and remain local.

## Start

Requirements: Node.js 24+, Git, and the Claude CLI authenticated locally.

```bash
npm ci
npm start
```

Open `http://127.0.0.1:4177`, connect an existing Git repository, describe a goal, review the proposed timeline, then accept it. Automatic mode may start ready steps but always stops at unmet dependencies and human gates.

Development uses `npm run dev`. The complete release gate is `npm run check`; production dependency status is `npm audit --omit=dev`.

## MCP

Run `npm run mcp` from an MCP client. The server uses stdio and the same SQLite-backed services as the Web UI. See [docs/mcp.md](docs/mcp.md).

## Operations

Copy `.env.example` values into your process environment as needed. The default database is `data/tracker.db`; run worktrees are under `data/worktrees`. Backups are available through `BackupService` and never overwrite an existing target. See [architecture](docs/architecture.md), [providers](docs/providers.md), and [troubleshooting](docs/troubleshooting.md).

Project MCP deliberately has no integration command. A human reviews the feature branch and chooses what happens outside this application.
