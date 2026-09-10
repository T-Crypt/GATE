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
| `claude` | Claude Code | `claude` | `--json-schema` | Aliases (`opus`, `sonnet`, `haiku`, `fable`) — open field |
| `opencode` | OpenCode | `opencode` | Prose contract, NDJSON stream | Enumerated by `opencode models` |
| `codex` | Codex | `codex` | `--output-schema` | Not enumerable — open field |
| `gemini` | Gemini CLI | `gemini` | Prose contract, JSON envelope | Suggestions — open field |
| `cursor` | Cursor Agent | `cursor-agent` | Prose contract, result envelope | Enumerated by `cursor-agent models` |
| `copilot` | Copilot CLI | `copilot` | Prose contract, plain text | Not enumerable — open field |

Two of them can be handed a machine-readable schema. **Claude** passes `timelineSchema` on `--json-schema`, and **Codex** writes it to a scratch file for `--output-schema` and reads the constrained answer back from `--output-last-message`. The other four get the same contract as prose (see [Timeline contract](#the-timeline-contract) below) and their answer is parsed leniently — a fenced JSON block is tolerated.

Because four of six rely on prose, an answer that is not JSON is the most likely way a draft fails. Gate treats that as a contract violation rather than a broken provider: `PROVIDER_OUTPUT_INVALID` and `PROVIDER_OUTPUT_INCOMPLETE` are retried once with the reason fed back through `draftTimeline`'s `feedback` argument. A provider that could not be launched is not retried.

### Per-adapter notes

**Claude** (`claude.js`) — invokes `claude --print --output-format stream-json`. Drafting disables tools entirely so the model returns the schema-constrained result instead of wandering into exploration. The CLI cannot list its models, but `--model` also accepts a full dated id, so the aliases are offered as suggestions and any id is accepted.

**OpenCode** (`opencode.js`) — `opencode run --format json` streams NDJSON; some builds echo the prompt back as its own text part, so that part is filtered out of run output, and drafts keep only the final `text` part. Drafts set `OPENCODE_PERMISSION={"bash":"deny","edit":"deny"}`; runs pass `--auto`. That variable is real in the shipped CLI but is not in OpenCode's published configuration reference, so it could change without appearing in a docs diff. On Windows npm installs only `.ps1`/`.cmd` shims, which cannot be spawned with `shell: false`, so Gate resolves the native `node_modules/opencode-ai/bin/opencode.exe` from the shim (`resolveExecutable()`, overridable with `OPENCODE_BIN_PATH`).

**Codex** (`codex.js`) — `codex exec -` reads the whole prompt from stdin, keeping multi-KB prompts off the command line. Runs use `--sandbox workspace-write`; drafts use `--sandbox read-only`. Model ids turn over every few weeks and the CLI cannot list them, so Gate suggests none and a blank model defers to `~/.codex/config.toml`. Auth is `codex login` or `CODEX_API_KEY`.

**Gemini** (`gemini.js`) — prompt on stdin, `--output-format stream-json` for runs and `json` for drafts, which arrives as a `{ response, stats, error }` envelope. Runs use `--approval-mode yolo`; drafts stay on `default` so the planner gets no tool it could write with. The CLI has no `auth status` subcommand, so Gate treats `GEMINI_API_KEY`/`GOOGLE_API_KEY`, or `oauth_creds.json` under `GEMINI_CLI_HOME` or the OS home, as the signed-in signal. Defaults to `auto`, which is the CLI's own default — Gemini's documentation disagrees with itself about whether `auto` routes by task complexity or resolves to Pro, so Gate does not claim either. Model suggestions are the documented aliases (`auto`, `pro`, `flash`, `flash-lite`) plus the two concrete 2.5 ids; the Gemini 3 ids are still `-preview`-suffixed and turn over, so the aliases are the stable way to ask for them.

**Cursor** (`cursor.js`) — `cursor-agent --print` with the prompt as the positional argument. Piped stdin is documented only as a trigger for inferring print mode, never as a source for the prompt. `--output-format stream-json` for runs (assistant and `tool_call` events), `json` for drafts (one `{ type: "result", result }` envelope). Runs pass `--force` to skip command approval; drafts deliberately do not, so a command the planner proposes is never approved.

Cursor is the one adapter whose draft path Gate cannot sandbox. Print mode reaches read and write tools regardless of `--force`, and unlike Codex (`--sandbox read-only`) or OpenCode (`OPENCODE_PERMISSION`) there is no lever Gate currently passes to prevent it. Drafting is still a read-and-reason task with no reason to write, but the guarantee here is weaker than for the other five. Gate's other boundaries are unaffected: a draft is a proposal, and nothing runs until a human accepts the timeline.

The installer now names the binary `agent` and keeps `cursor-agent` as a legacy symlink; Gate still invokes `cursor-agent`, which remains correct. Auth is `cursor-agent login` or `CURSOR_API_KEY`.

**Copilot** (`copilot.js`) — no structured output mode at all; it writes prose, and drafting works because the timeline contract ships as prose too. The prompt arrives on stdin, which the CLI reads when `-p` is absent — Gate omits `-p` deliberately, because a prompt on the command line would truncate at Windows' ~32 KB ceiling. Runs pass `--allow-all-tools`; drafts pass neither that nor `--allow-tool`, plus `--no-ask-user` so a headless CLI can never block on a question it cannot show. Auth reads `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`.

## Provider contract

A provider implements two methods:

- `start(request, observer)` — run one timeline step; returns a cancellable session plus a completion promise
- `draftTimeline({ goal, repositoryContext, cwd, model, env, feedback })` — propose a dependency-aware timeline for a goal

Plus two optional hooks:

- `listModels()` — return the reachable models for the Settings page and save-time model validation (`GET /providers/:kind/models`). A provider without it gets no model dropdown; the project's `providerConfig.model` is still passed through verbatim.
- `capabilities()` — `{ streaming, structuredDrafts }`, reported by `GET /providers`. It carries only what a caller consults: resumption is not declared because Gate resumes no run (see [Session resumption](#session-resumption)), and model discovery is not declared because `listModels().complete` already answers that.

### Which backends this machine can reach

`GET /providers` returns the roster: for each `providerKind`, its declared capabilities, whether it can draft, how many models it reported, and an `availability` of `ready`, `unreachable`, or `unknown`. The Settings page draws it as a strip under the backend picker.

Probing means one process per provider, so probes run concurrently, are capped at five seconds each, and are cached for thirty. A CLI that is missing, signed out, or throwing is reported as data — never as an error — and the settings page renders before the roster arrives rather than waiting on it. The label is *not detected* rather than *not installed*, because the probes cannot tell a missing executable from a signed-out one: both exit non-zero.

This exists so `PROVIDER_UNAVAILABLE` is a condition you can see coming. Without it the first news of a missing CLI arrived only after a timeline had been drafted, reviewed, and a step started.

### Complete and incomplete catalogs

`listModels()` may return `complete: false`, which says the list is a *suggestion* rather than the reachable set. It matters in two places:

- **Save-time validation** only rejects an unknown model when the catalog is complete. Rejecting an id merely absent from a suggestion list would block models the CLI reaches perfectly well.
- **The Settings and draft model fields** render a closed `<select>` for a complete catalog and a typable combobox for an incomplete one, so a model Gate has never heard of is still selectable.

Omitting the field means complete, so an adapter that enumerates its models needs no change.

## Session resumption

Every shipped adapter can resume a session upstream. Verified against each vendor's current documentation, or its local `--help`, in September 2026:

| Provider | Resumption surface |
| --- | --- |
| Claude Code | `-r/--resume [id]`, `-c/--continue`, `--fork-session` |
| Codex | `codex exec resume [SESSION_ID]`, `--last` |
| OpenCode | `-s/--session`, `-c/--continue`, `--fork`, `opencode session` |
| Gemini CLI | `-r/--resume` accepting `latest`, an index, or an id |
| Cursor | `--resume [chatId]`, `--continue`, `agent resume`, `agent ls` |
| Copilot | `--resume[=SESSION-ID]`, `--continue`, `--session-id ID` |

Gate uses none of them, and `capabilities()` does not claim otherwise. The `runs.provider_session_id` column has stored a handle since the first migration, and the Codex, Cursor, and OpenCode adapters write the CLI's real id into it, but nothing reads it back.

Resumption is deliberately not built, because the flag is the easy part. A resumed run has to answer questions the run model has no answers for yet:

- **Is it the same run?** History is append-only through the event store, and a run row carries one `started_at`, one `finished_at`, and one status. Reusing the row means mutating history behind the event architecture; a second row means a run needs a parent, and the timeline has to understand that two rows are one attempt.
- **The worktree is gone.** Cancelling a run tears down its linked worktree. Resuming means either keeping cancelled worktrees indefinitely — unbounded disk, held by a user who may never return — or recreating one, in which case the CLI resumes a conversation about a directory whose contents have changed underneath it. The second is worse than starting over, because the model believes it knows what the files say.
- **Evidence is commit-bound.** Evidence carries `headSha` and `fileScope` and goes stale when the branch moves. A resumed run that lands new commits has to invalidate whatever the first attempt submitted, and the staleness rules are written for a branch moving under a gate, not for a run resuming beneath one.
- **The handle is not always the right handle.** Cursor's `--resume` takes a *chat* id, and its documentation never states that the `session_id` in the event stream is the same identifier. Codex's `thread_id` is documented as resumable and is safe. Each provider needs its own round-trip test before Gate claims resumption works for it.

The smallest honest first step, whenever this is picked up, is to capture the real session id in the two adapters that discard it: Gemini's `init` event and JSON envelope both carry one, and Copilot accepts `--session-id ID`, so Gate can dictate a UUID the way the Claude adapter already does. That makes the stored column true for all six without promising a feature. Resumption itself belongs in its own change, with its own design pass on the run model.

One further asymmetry to plan around: `codex exec resume` does not accept `-s/--sandbox`, so a resumed Codex run would have to get `workspace-write` from `-c sandbox_mode=...` or `config.toml`.

## The timeline contract

`server/adapters/providers/timeline-contract.js` holds one description of the timeline shape in two forms: `timelineSchema` (JSON Schema, for providers that accept one) and `timelineContractPrompt` (the same rules as prose, for those that don't). `normalizeTimelineGraph` in `server/application/timeline-service.js` is the authority on what Gate accepts — a draft that satisfies the schema must survive normalization, or the provider round-trips for ~30s and the draft is rejected anyway.

The schema also has to be legal where it is forwarded. Codex sends it on as an OpenAI strict structured output, and strict mode rejects a schema whose `required` omits a declared property, so every property is required and the optional ones are unioned with `null` — which is how strict mode spells "optional". Normalization coerces each of those nulls to its default, and a gate with `blocking: null` still reads as blocking rather than silently opening.

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
