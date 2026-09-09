# Troubleshooting

- `/health` proves the process responds; `/ready` also proves SQLite is queryable.
- `INVALID_REPOSITORY`: connect an existing local Git checkout with a `.git` entry.
- `DIRTY_BASE_WORKTREE`: commit or stash base-checkout changes before starting a run.
- `STEP_BLOCKED`: finish dependencies or satisfy gates; direct starts cannot bypass them.
- `STALE_EVIDENCE`: rerun validation at the current run HEAD and submit new evidence.
- `PROVIDER_UNAVAILABLE`: the project's provider is not registered or its CLI is not reachable — install/authenticate the Claude CLI or OpenCode CLI and confirm `providerKind` on the project.
- An `interrupted` run remains reviewable after restart and its node becomes blocked.

For recovery, stop the service, retain `data/tracker.db` and `data/worktrees`, and create a checksummed backup to a new path. Never overwrite the only known-good backup. SQLite WAL mode is checkpointed during graceful shutdown.
