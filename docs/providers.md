# Provider adapters

Claude is the first adapter. It invokes the local `claude` executable without a shell, uses streamed JSON output, bounds captured output, redacts common secret patterns, and runs only in the assigned worktree.

A future provider implements the same `start(request, observer)` and `draftTimeline({ goal, repositoryContext, cwd, model, env })` contract, returns a cancellable session plus completion promise, and never owns branch, timeline, gate, or approval policy. Provider credentials remain in that provider's local environment; do not persist secrets in project configuration.

## OpenCode

OpenCode (`opencode`) is the second adapter and ships as `server/adapters/providers/opencode.js`. It runs the OpenCode CLI over the same process contract, so everything about isolation, output bounding, redaction, and branch policy applies unchanged.

- **Executable:** on Linux and macOS the bare `opencode` command resolves from PATH. On Windows the npm install only provides `opencode.ps1`/`opencode.cmd` shims, which cannot be spawned with `shell: false`; Gate resolves the native `node_modules/opencode-ai/bin/opencode.exe` from the shim instead. Set `OPENCODE_BIN_PATH` to override discovery.
- **Model:** projects may fix a model in `providerConfig.model`. OpenCode exposes Gate's default as `opencode/big-pickle`; the setting and the timeline draft form both accept a `provider/model` string. Drafts also accept a per-draft model override.
- **Prompts:** `opencode run` reads the prompt from stdin, so there is no shell interpolation and no Windows command-line length limit.
- **Output:** `--format json` streams NDJSON. Run output is surfaced from `text` events (the echoed prompt is filtered out); drafts keep only the final `text` part, which is the assistant's answer, and parse it as the timeline graph. A fenced JSON block is tolerated.
- **Permissions:** drafts set `OPENCODE_PERMISSION={"bash":"deny","edit":"deny"}` so the planner reasons over the goal text and returns JSON instead of exploring the filesystem. Execution runs pass `--auto` so approved steps can work inside the isolated worktree without prompting.