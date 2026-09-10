---
layout: default
title: Troubleshooting
permalink: /docs/troubleshooting/
---

Error codes, interrupted runs, and the recovery procedure for the local database. Health endpoints first, then the codes you'll actually meet, grouped by area. The same `{ error: { code, message } }` envelope is used by the HTTP API and the MCP surface.

## Health endpoints

- `GET /health` — proves the process responds.
- `GET /ready` — also proves SQLite is queryable.

## Error codes

### Connect and repository

| Code | Meaning and fix |
| --- | --- |
| `INVALID_REPOSITORY` | The connected path is not a Git checkout. Connect an existing local repository with a `.git` entry. |
| `DETACHED_HEAD` | The base checkout has no default branch checked out. Check out the default branch before connecting or running. |
| `PROTECTED_BRANCH` | The operation would touch a protected branch (the connected default branch, plus any stable/production branches). Gate never executes on, merges, pushes, deletes, or rewrites them. |
| `BASE_BRANCH_NOT_PROTECTED` | A branch policy was configured against a base that is not the protected default branch. Adjust the policy. |

### Runs and steps

| Code | Meaning and fix |
| --- | --- |
| `DIRTY_BASE_WORKTREE` | The base checkout has uncommitted changes. Commit or stash them before starting a run. (Gate's own append of the `.gate/` ignore entry to `.gitignore` is exempt from this check.) |
| `STEP_BLOCKED` | Dependencies are unfinished or gates unsatisfied. Finish dependencies or satisfy gates; direct starts cannot bypass them. |
| `STEP_NOT_READY` | The step is not in a state that can start (not `ready`). Advance or re-schedule it. |
| `STEP_REQUIRED` | A run needs a concrete timeline step; none was identified. Pick a `ready` step. |
| `RUN_ALREADY_ACTIVE` | The node already has an active run. Cancel it first. |
| `RUN_NOT_ACTIVE` | The run is not in an active (started) state. Only active runs can be cancelled. |
| `WORKTREE_EXISTS` / `WORKTREE_REQUIRED` | A run worktree already exists where one was being created, or a run expects a worktree that is missing. Inspect `data/worktrees` and clean up. |
| `DIRTY_RUN_WORKTREE` | The run worktree has uncommitted changes when the run needs a clean state. Commit or stash inside the run worktree. |
| `BASE_BRANCH_MOVED` | The base branch changed under an active run. Re-anchor or restart the run. |

### Timeline and drafts

| Code | Meaning and fix |
| --- | --- |
| `DANGLING_EDGE` | A timeline edge references a node that does not exist. Correct the draft or use `timeline_replace_draft`. |
| `TIMELINE_CYCLE` | The proposed graph contains a dependency cycle. Remove the cycle and re-draft. |
| `INVALID_PARENT` | A step is parented to a node that is not a milestone (or a milestone is parented to anything). |
| `INVALID_GATE_NODE` | A gate references a timeline node that does not exist. |
| `DRAFT_NOT_PROPOSED` | The draft being accepted is not in `proposed` state. Only proposed drafts can be accepted. |
| `LOCKED_NODE_CONFLICT` / `ACTIVE_NODE_CONFLICT` | A draft replacement would change a locked, running, review, or approved node. Existing accepted work is protected — re-plan around it. |

### Gates and evidence

| Code | Meaning and fix |
| --- | --- |
| `STALE_EVIDENCE` | The branch moved or an in-scope file changed after evidence was submitted. Re-run validation at the current run HEAD and submit new evidence. |
| `HUMAN_REVIEW_REQUIRED` | Only a human actor can decide an approval gate. Gate rejects an agent that tries to approve its own work. |

### Providers

| Code | Meaning and fix |
| --- | --- |
| `PROVIDER_UNAVAILABLE` | The project's `providerKind` is not registered, or its CLI is not reachable. Install and sign in to the CLI for that kind — one of `claude`, `opencode`, `codex`, `gemini`, `cursor`, `copilot`. You should not have to meet this code by surprise: the Settings page shows which backends this machine can reach, and `GET /providers` returns the same roster. |
| `PROVIDER_LAUNCH_FAILED` | The provider process could not be spawned — usually the executable is not on `PATH`. Check the CLI name and permissions. Drafts are not retried after this, because a retry cannot conjure a missing binary. |
| `PROVIDER_OUTPUT_INVALID` | The provider answered with something that is not the timeline JSON — prose, a partial object, or a fence Gate could not unwrap. Four of the six adapters only get the contract as prose, so this is the ordinary way a draft misses. Gate already retries once with the reason fed back; meeting the code means the second attempt missed too. Rephrase the goal, or switch to `claude` or `codex`, which are handed a real schema. |
| `PROVIDER_OUTPUT_INCOMPLETE` | The provider exited cleanly having produced no timeline, or an empty object. Also retried once automatically. |
| `PROVIDER_FAILED` | The provider process exited non-zero. The message carries the CLI's own reason where it printed one — an unreachable model, an expired login, a rejected flag. Inspect the run output or stderr. Not retried. |
| `DRAFTING_UNSUPPORTED` | The configured provider implements no `draftTimeline`. All six shipped adapters do, so this only appears behind a custom provider map. |
| `UNKNOWN_PROVIDER` | No adapter is registered under that `providerKind`. |
| `UNKNOWN_MODEL` | The model is absent from a catalog the CLI could fully enumerate — today only `opencode` and `cursor`. A provider reporting `complete: false` accepts any id, so this code cannot fire for it. |

### Provider failure modes that are not error codes

- **Codex writes a scratch directory.** Drafting creates a temporary directory under the OS temp dir (`gate-codex-*`) to hold the schema and the constrained answer, and removes it even when the CLI fails. A temp dir that is read-only or full makes drafting fail before Codex starts.
- **A run whose output exceeds the cap is truncated, not failed.** Each adapter stops recording after `GATE_OUTPUT_LIMIT_BYTES` and marks the run truncated; the process keeps going.
- **Cursor drafting is not sandboxed.** Cursor's print mode reaches read and write tools and Gate has no lever to prevent it, unlike Codex and OpenCode. See [Provider adapters]({% link docs/providers.md %}).
- **Exit-code meanings are mostly undocumented.** Of the six CLIs, only success (`0`) and "non-zero means failure" are documented across the board. Gate therefore reports whatever the CLI printed rather than mapping a number to a cause, which is why `PROVIDER_FAILED` messages quote the CLI.

### Memory, context, and planning

| Code | Meaning and fix |
| --- | --- |
| `MEMORY_STALE` | GATE Memory is not current (or the repository moved while context was being compiled). Run `memory_refresh` (or refresh in the Memory UI) and retry — planning never refreshes implicitly. |
| `PLANNING_ALREADY_PROPOSED` | The source already has a proposed planning request. Resolve or accept it before proposing again. |
| `PLANNING_NOT_PROPOSED` | The planning request being accepted is not `proposed`. Only proposed requests can be accepted. |
| `EXPANSION_CONFLICT` | A generated expansion step collided with an existing timeline node. The expansion was rejected and the timeline is untouched. |
| `INVALID_FEATURE_TRANSITION` | The requested feature status change is not allowed by the declared lifecycle. |

Plan staleness is advisory, not an error: a `STALE` or `POSSIBLY_STALE` result reports that the repository moved past the plan's grounding, and a step started against a drifted plan warns rather than failing. A repository that cannot answer the comparison (an unreachable grounding commit) reports `POSSIBLY_STALE` instead of raising. Re-grounding proposes a new plan and can therefore return `PLANNING_ALREADY_PROPOSED` if the same source already has one waiting.

### Remote observation

| Code | Meaning and fix |
| --- | --- |
| `REMOTE_NOT_CONFIGURED` | No `GATE_GITHUB_TOKEN` is set, so remote sync is disabled. Set the token (and `GATE_GITHUB_API_URL` for Enterprise) to observe remote PRs and issues. |
| `REMOTE_UNAUTHORIZED` | The GitHub token is invalid or lacks access. Rotate or re-scope the token. |
| `REMOTE_NOT_FOUND` | The repository or endpoint does not exist on the remote. |
| `REMOTE_ERROR` / `REMOTE_UNKNOWN` | The remote request failed. Check the log for the underlying status. |

### Idempotency and transport

| Code | Meaning and fix |
| --- | --- |
| `IDEMPOTENCY_REQUIRED` | The mutation was called without an actor + idempotency key. Retry with an `idempotencyKey` (HTTP: `Idempotency-Key` header). |
| `IDEMPOTENCY_CONFLICT` | The same idempotency key was reused for a different request. Use a fresh key. |
| `INVALID_JSON` | The request body was not valid JSON. |
| `ROUTE_NOT_FOUND` | The path does not exist. |
| `VALIDATION_FAILED` | The request failed payload validation. Read the `message` for the specific field. |
| `NOT_FOUND` | The requested project, run, node, feature, or request does not exist. |
| `INTERNAL_ERROR` | Unhandled failure. Check the server log and the `AppError` details. |

## Interrupted runs

An `interrupted` run remains reviewable after restart, and its timeline node becomes blocked.

## Recovery and backups

1. Stop the service gracefully — SQLite WAL mode is checkpointed during graceful shutdown.
2. Retain `data/tracker.db` (the database) and `data/worktrees` (run worktrees).
3. Create a checksummed backup to a **new** path: `BackupService.create(target)` performs an online SQLite backup and returns its SHA-256; `BackupService.exportJson(target)` dumps all tables as versioned JSON. Both refuse to overwrite an existing target — never overwrite the only known-good backup.