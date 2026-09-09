---
layout: default
title: Provider adapters
permalink: /docs/providers/
---

Claude is the first adapter (`server/adapters/providers/claude.js`). It invokes the local `claude` executable without a shell, uses streamed JSON output, bounds captured output (`GATE_OUTPUT_LIMIT_BYTES`, default 2 MB), redacts common secret patterns, and runs only in the assigned worktree.

OpenCode (`server/adapters/providers/opencode.js`) is the second adapter and follows the same contract.

## Provider contract

A provider implements two methods:

- `start(request, observer)` — run one timeline step; returns a cancellable session plus a completion promise
- `draftTimeline({ goal, repositoryContext, cwd, model, env })` — propose a dependency-aware timeline for a goal

Providers never own branch, timeline, gate, or approval policy — those live in the domain. Provider credentials remain in that provider's local environment; do not persist secrets in project configuration.

## Adding a provider

A new adapter ships by implementing the two methods above against the same request and observer shapes the Claude adapter uses — no changes to the domain, the HTTP API, or the MCP tool surface are required. The [MCP interface]({% link docs/mcp.md %}) already works for any connected agent; what is provider-specific today is only which executable Gate schedules when a step starts.

## Choosing a provider

Each project stores a `providerKind` (default `claude`) and a small `providerConfig` object. The Settings page in the workstation switches a project's backend and model; new projects keep Claude. OpenCode specifics:

- **Executable:** on Linux and macOS the bare `opencode` command resolves from PATH. On Windows npm installs only `.ps1`/`.cmd` shims that cannot be spawned with `shell: false`, so Gate resolves the native `node_modules/opencode-ai/bin/opencode.exe` from the shim. Set `OPENCODE_BIN_PATH` to override discovery.
- **Model:** OpenCode's default is `opencode/big-pickle`; a `providerConfig.model` (or a per-draft choice on the timeline form) overrides it with any `provider/model` string.
- **Prompts:** `opencode run` reads the prompt from stdin — no shell interpolation, no Windows command-line length limit.
- **Output:** `--format json` streams NDJSON. Run output surfaces from `text` events with the echoed prompt filtered out; drafts keep only the final `text` part (the assistant's answer) and parse it as the timeline graph, tolerating a fenced JSON block.
- **Permissions:** drafts set `OPENCODE_PERMISSION={"bash":"deny","edit":"deny"}` so the planner returns JSON instead of exploring; execution runs pass `--auto` so approved steps can work inside the isolated worktree without prompting.
