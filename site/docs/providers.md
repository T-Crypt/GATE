---
layout: default
title: Provider adapters
permalink: /docs/providers/
---

Gate talks to an agent through a small adapter contract. Everything else about how a run is scheduled and gated lives in the domain, not in the provider.

## The two adapters

**[Claude](https://github.com/T-Crypt/GATE/blob/main/server/adapters/providers/claude.js)** (`server/adapters/providers/claude.js`) — the first adapter. It invokes the local `claude` executable without a shell, uses streamed JSON output, bounds captured output (`GATE_OUTPUT_LIMIT_BYTES`, default 2 MB), redacts common secret patterns, and runs only in the assigned worktree.

**[OpenCode](https://github.com/T-Crypt/GATE/blob/main/server/adapters/providers/opencode.js)** (`server/adapters/providers/opencode.js`) — the second adapter, following the same contract. Windows specifics:

- **Executable** — on Linux and macOS the bare `opencode` command resolves from PATH. On Windows npm installs only `.ps1`/`.cmd` shims that cannot be spawned with `shell: false`, so Gate resolves the native `node_modules/opencode-ai/bin/opencode.exe` from the shim (`resolveExecutable()`, overridable with `OPENCODE_BIN_PATH`).
- **Model** — defaults to `opencode/big-pickle`; a project's `providerConfig.model` (or a per-draft choice on the timeline form) overrides it with any `provider/model` string.
- **Prompts** — `opencode run` reads the prompt from stdin: no shell interpolation, no Windows command-line length limit.
- **Output** — `--format json` streams NDJSON. Run output surfaces from `text` events with the echoed prompt filtered out; drafts keep only the final `text` part (the assistant's answer) and parse it as the timeline graph, tolerating a fenced JSON block.
- **Permissions** — drafts set `OPENCODE_PERMISSION={"bash":"deny","edit":"deny"}` so the planner returns JSON instead of exploring; execution runs pass `--auto` so approved steps can work inside the isolated worktree without prompting.

## Provider contract

A provider implements two methods:

- `start(request, observer)` — run one timeline step; returns a cancellable session plus a completion promise
- `draftTimeline({ goal, repositoryContext, cwd, model, env })` — propose a dependency-aware timeline for a goal

Plus one optional hook used only for the model catalog:

- `listModels()` — return the reachable models for the Settings page and save-time model validation (`GET /providers/:kind/models`). A provider without it gets no model dropdown; the project's `providerConfig.model` is still passed through verbatim.

Provider output must satisfy the shared timeline contract (node kinds, edge and gate types, DAG acyclicity) that both adapters enforce against the same `normalizeTimelineGraph` rules — a draft that satisfies the schema survives normalization. Providers never own branch, timeline, gate, or approval policy — those live in the domain. Provider credentials stay in that provider's local environment; do not persist secrets in project configuration.

## Adding a provider

A new adapter ships by implementing the methods above against the same request and observer shapes the existing adapters use (`listModels` is optional); no changes to the domain, the HTTP API, or the MCP tool surface are required. The [MCP interface]({% link docs/mcp.md %}) already works for any connected agent; what is provider-specific today is only which executable Gate schedules when a step starts.

## Choosing a provider

Each project stores a `providerKind` (default `claude`) and a small `providerConfig` object. The Settings page in the workstation switches a project's backend and model; new projects keep Claude. The MCP server and tools are provider-agnostic — a connected agent does not have to be the one Gate schedules to run a step; its `providerKind` decides.