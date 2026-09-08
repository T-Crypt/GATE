---
layout: page
title: Troubleshooting
permalink: /docs/troubleshooting/
---

## Health endpoints

- `GET /health` — proves the process responds.
- `GET /ready` — also proves SQLite is queryable.

## Error codes

| Code | Meaning and fix |
| --- | --- |
| `INVALID_REPOSITORY` | The connected path is not a Git checkout. Connect an existing local repository with a `.git` entry. |
| `DIRTY_BASE_WORKTREE` | The base checkout has uncommitted changes. Commit or stash them before starting a run. (Gate's own append of the `.gate/` ignore entry to `.gitignore` is exempt from this check.) |
| `STEP_BLOCKED` | Dependencies are unfinished or gates unsatisfied. Finish dependencies or satisfy gates; direct starts cannot bypass them. |
| `STALE_EVIDENCE` | The branch moved or an in-scope file changed after evidence was submitted. Re-run validation at the current run HEAD and submit new evidence. |
| `PROVIDER_UNAVAILABLE` | The provider cannot be reached. Install and authenticate the Claude CLI, or configure a future provider adapter. |

## Interrupted runs

An `interrupted` run remains reviewable after restart, and its timeline node becomes blocked.

## Recovery and backups

1. Stop the service gracefully — SQLite WAL mode is checkpointed during graceful shutdown.
2. Retain `data/tracker.db` (the database) and `data/worktrees` (run worktrees).
3. Create a checksummed backup to a **new** path: `BackupService.create(target)` performs an online SQLite backup and returns its SHA-256; `BackupService.exportJson(target)` dumps all tables as versioned JSON. Both refuse to overwrite an existing target — never overwrite the only known-good backup.
