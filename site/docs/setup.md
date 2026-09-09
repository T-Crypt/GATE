---
layout: default
title: Setup & Operations
permalink: /docs/setup/
---

Requirements, npm scripts, environment configuration, the on-disk data layout, and how backups work.

## Requirements

- Node.js 24+
- Git
- A provider CLI authenticated locally — the Claude adapter invokes the `claude` executable; OpenCode support is the same contract

## Install and run

```bash
npm ci
npm start
```

Open <http://127.0.0.1:4177>, connect an existing Git repository, describe a goal, review the proposed timeline, then accept it. Automatic mode starts ready steps on its own but always stops at unmet dependencies and human gates.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm start` | Run the server (`node server/index.js`) |
| `npm run dev` | Run with `--watch` for development |
| `npm run mcp` | Start the MCP stdio server directly |
| `npm test` | Node test runner (unit + integration) |
| `npm run test:unit` / `npm run test:integration` | Individual suites |
| `npm run test:browser` | Playwright browser tests |
| `npm run lint` | Syntax-check all JS in `server/`, `public/js/`, and `tests/` |
| `npm run check` | Full release gate: lint + unit + integration + browser tests |

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback values require `ALLOW_REMOTE_BIND=true`. |
| `PORT` | `4177` | HTTP port. |
| `GATE_DATA_DIR` | `./data` | Root for the database, worktrees, and validation artifacts. |
| `GATE_JSON_LIMIT` | `1mb` | Maximum JSON body size for the HTTP API. |
| `GATE_OUTPUT_LIMIT_BYTES` | `2000000` | Cap on captured provider output. |
| `LOG_LEVEL` | `info` | Log verbosity. |
| `ALLOW_REMOTE_BIND` | `false` | Permit binding to a non-loopback host. |
| `GATE_GITHUB_TOKEN` | *(unset)* | GitHub token enabling the read-only remote overview (open PRs and issues) in the Git view. Gate only reads; it never creates, merges, or pushes. |
| `GATE_GITHUB_API_URL` | `https://api.github.com` | GitHub REST API base URL; override for GitHub Enterprise. |

> Tokens are read from the environment, never from project configuration or the database. Gate holds no credentials itself.

## Data layout

Under `GATE_DATA_DIR` (default `data/`):

- `tracker.db` — the SQLite database; the source of truth.
- `worktrees/` — linked worktrees, one per run, on branches named `<project-prefix><run-id>` (`work/gate-<run-id>` by default; the prefix is set per project at connect time or from Settings).
- `tests/<project-id>/` — validation artifacts; always local.

Runs never execute against the base checkout; every run uses its own linked worktree from that prefix.

## Backups

Backups go through `BackupService` and never overwrite an existing target:

- `create(targetPath)` — online SQLite backup to a new path, returning the file's SHA-256.
- `exportJson(targetPath)` — all tables as versioned JSON, written with mode `0600`.

See [Troubleshooting]({% link docs/troubleshooting.md %}) for the recovery procedure.