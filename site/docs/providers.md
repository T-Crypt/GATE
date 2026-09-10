---
layout: default
title: Provider adapters
permalink: /docs/providers/
---

Gate talks to an agent through a small adapter contract. Everything else about how a run is scheduled and gated lives in the domain, not in the provider.

## The shipped adapters

Six adapters ship in `server/adapters/providers/`, all registered in `server/composition.js`. Each drives a locally installed agent CLI: Gate spawns it without a shell, hands it the prompt, and reads the answer back. No adapter reaches the network on Gate's behalf, and no provider credential is ever stored in the project — each CLI keeps its own login.

| `providerKind` | CLI | Executable | Draft output | Model catalog |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code | `claude` | `--json-schema` | Aliases (`opus`, `sonnet`, `haiku`) |
| `opencode` | OpenCode | `opencode` | Prose contract, NDJSON stream | Enumerated by `opencode models` |
| `codex` | Codex | `codex` | `--output-schema` | Not enumerable — open field |
| `gemini` | Gemini CLI | `gemini` | Prose contract, JSON envelope | Suggestions — open field |
| `cursor` | Cursor Agent | `cursor-agent` | Prose contract, result envelope | Enumerated by `cursor-agent models` |
| `copilot` | Copilot CLI | `copilot` | Prose contract, plain text | Not enumerable — open field |

Two of them can be handed a machine-readable schema. **Claude** passes `timelineSchema` on `--json-schema`, and **Codex** writes it to a scratch file for `--output-schema` and reads the constrained answer back from `--output-last-message`. The other four get the same contract as prose (see [Timeline contract](#the-timeline-contract) below) and their answer is parsed leniently — a fenced JSON block is tolerated.

### Per-adapter notes

**Claude** (`claude.js`) — invokes `claude --print --output-format stream-json`. Drafting disables tools entirely so the model returns the schema-constrained result instead of wandering into exploration.

**OpenCode** (`opencode.js`) — `opencode run --format json` streams NDJSON; the echoed prompt is filtered out of run output, and drafts keep only the final `text` part. Drafts set `OPENCODE_PERMISSION={"bash":"deny","edit":"deny"}`; runs pass `--auto`. On Windows npm installs only `.ps1`/`.cmd` shims, which cannot be spawned with `shell: false`, so Gate resolves the native `node_modules/opencode-ai/bin/opencode.exe` from the shim (`resolveExecutable()`, overridable with `OPENCODE_BIN_PATH`).

**Codex** (`codex.js`) — `codex exec -` reads the whole prompt from stdin, keeping multi-KB prompts off the command line. Runs use `--sandbox workspace-write`; drafts use `--sandbox read-only`. Model ids turn over every few weeks and the CLI cannot list them, so Gate suggests none and a blank model defers to `~/.codex/config.toml`. Auth is `codex login` or `CODEX_API_KEY`.

**Gemini** (`gemini.js`) — prompt on stdin, `--output-format stream-json` for runs and `json` for drafts, which arrives as a `{ response, stats, error }` envelope. Runs use `--approval-mode yolo`; drafts stay on `default` so the planner gets no tool it could write with. The CLI has no `auth status` subcommand, so Gate treats `GEMINI_API_KEY`/`GOOGLE_API_KEY` or `~/.gemini/oauth_creds.json` as the signed-in signal. Defaults to `auto`, which routes between Pro and Flash by task complexity.

**Cursor** (`cursor.js`) — `cursor-agent --print` with the prompt on stdin. `--output-format stream-json` for runs (assistant and `tool_call` events), `json` for drafts (one `{ type: "result", result }` envelope). Runs pass `--force` to skip command approval; drafts deliberately do not. Auth is `cursor-agent login` or `CURSOR_API_KEY`.

**Copilot** (`copilot.js`) — the only adapter with no structured output mode at all; it writes prose, and drafting works because the timeline contract ships as prose too. It also has no stdin mode, so the prompt is the value of `-p`. That is fine on Linux and macOS, but Windows caps a command line at ~32 KB — a very large step prompt can hit it. Runs pass `--allow-all-tools`; drafts pass neither that nor `--allow-tool`, plus `--no-ask-user` so a headless CLI can never block on a question it cannot show. Auth reads `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`.

## Provider contract

A provider implements two methods:

- `start(request, observer)` — run one timeline step; returns a cancellable session plus a completion promise
- `draftTimeline({ goal, repositoryContext, cwd, model, env, feedback })` — propose a dependency-aware timeline for a goal

Plus one optional hook used only for the model catalog:

- `listModels()` — return the reachable models for the Settings page and save-time model validation (`GET /providers/:kind/models`). A provider without it gets no model dropdown; the project's `providerConfig.model` is still passed through verbatim.

### Complete and incomplete catalogs

`listModels()` may return `complete: false`, which says the list is a *suggestion* rather than the reachable set. It matters in two places:

- **Save-time validation** only rejects an unknown model when the catalog is complete. Rejecting an id merely absent from a suggestion list would block models the CLI reaches perfectly well.
- **The Settings and draft model fields** render a closed `<select>` for a complete catalog and a typable combobox for an incomplete one, so a model Gate has never heard of is still selectable.

Omitting the field means complete, so an adapter that enumerates its models needs no change.

## The timeline contract

`server/adapters/providers/timeline-contract.js` holds one description of the timeline shape in two forms: `timelineSchema` (JSON Schema, for providers that accept one) and `timelineContractPrompt` (the same rules as prose, for those that don't). `normalizeTimelineGraph` in `server/application/timeline-service.js` is the authority on what Gate accepts — a draft that satisfies the schema must survive normalization, or the provider round-trips for ~30s and the draft is rejected anyway.

Provider output is untrusted after parsing. It becomes a *candidate* graph; the domain decides whether it is a timeline. Providers never own branch, timeline, gate, or approval policy.

## Adding a provider

A new adapter ships by implementing the methods above against the same request and observer shapes the existing adapters use (`listModels` is optional); no changes to the domain, the HTTP API, or the MCP tool surface are required. `server/adapters/providers/cli-support.js` carries the parts every CLI-backed adapter needs — NDJSON line reading across chunk boundaries, fenced-JSON tolerance, failure-message extraction from a CLI's own output, and auth probing — so a new adapter is mostly its argv and its event shape.

Three places outside the adapter need the new kind:

1. `server/composition.js` — one entry in the provider map
2. `public/js/settings.js` — one entry in `PROVIDERS`, the backend picker
3. `public/js/components.js` — a display name in `providerName` and, if the CLI has a nameable default, an entry in `providerModelDefault`

The [MCP interface]({% link docs/mcp.md %}) already works for any connected agent; what is provider-specific is only which executable Gate schedules when a step starts.

## Choosing a provider

Each project stores a `providerKind` (default `claude`) and a small `providerConfig` object. The Settings page in the workstation switches a project's backend and model; new projects keep Claude. The MCP server and tools are provider-agnostic — a connected agent does not have to be the one Gate schedules to run a step; its `providerKind` decides.
