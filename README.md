# project-tracker

Local, single-user project tracker: git/issue dashboard, an agent-driving chat
interface, and a milestone timeline. Node + Express + SQLite backend, no-build
vanilla JS frontend.

## What's actually built (MVP)

- **Dashboard tab** — git log sync (reads a repo path on disk via `git log`),
  a simple issue tracker, and tagged notes. All backed by SQLite.
- **Agent tab** — spawns a configurable CLI command (`claude` by default) per
  project, streams stdout/stderr live over WebSocket, keeps session history.
- **Timeline tab** — manually created milestones as colored tiles, each with
  a numbered grid of prompt steps. Click a tile to open it, add steps, lock
  status.

## What's explicitly NOT built yet

This scaffold intentionally stops short of the full spec. In order of what's
worth building next:

1. **Agent → step wiring.** The Agent tab and Timeline tab don't talk to each
   other yet. Clicking a step should call `POST /api/projects/:id/agent/run`
   with `promptStepId` set (the route already supports it) and switch to the
   Agent tab to watch it run.
2. **AI milestone drafting.** Nothing generates milestones from a goal
   description yet. This needs its own endpoint that takes a goal string,
   calls out to an LLM (local Ollama or Claude), and returns a milestone/step
   JSON structure matching the `milestones`/`prompt_steps` schema.
3. **Live redraw on edit.** Right now editing a milestone just updates that
   row. "Redraw the whole timeline when one milestone changes" needs a diffing
   pass, not a blind regenerate, or you'll fight it every time you touch a
   locked milestone.
4. **Infra crossover detection.** No correlation logic exists between git
   activity/milestones and your actual infrastructure (JumpCloud, Meraki,
   Proxmox, etc). This is the vaguest part of the spec — needs a concrete
   definition of what "crossover" means before it's buildable. Realistic
   starting point: grep commit messages and prompt text for known hostnames/
   client names from your `projects` table and surface matches as a sidebar,
   not real infra polling.
5. **MCP interface.** `/timeline review next steps` over MCP means writing an
   MCP server that wraps the same `/api/projects/:id/milestones` and
   `/api/projects/:id/agent/run` endpoints already in this scaffold — the
   HTTP API is the thing to build the MCP tool calls against.
6. **Multi-provider chat, local Ollama support.** Bridge currently spawns one
   CLI command. Swapping providers means either running different `agent_cmd`
   values per project (works today) or building a real provider abstraction
   if you want to switch mid-session.

## Running it

```bash
cd project-tracker
npm install
npm start
```

Opens on `http://localhost:4177`. First launch prompts you to add a project —
give it a name and the absolute path to a git repo on this machine (e.g. your
`tindall` homelab repos). The agent CLI command defaults to `claude`; point it
at a local Ollama wrapper script if that's what you want for a given project.

## Schema

See `server/schema.sql`. Six tables: `projects`, `milestones`, `prompt_steps`,
`notes`/`tags`/`note_tags`, `git_events`, `issues`, `agent_sessions`. Nothing
exotic — no vector DB, no graph store. Add one only when you actually have a
retrieval problem the relational schema can't answer; right now it can.

## Known rough edges

- The agent bridge assumes the CLI accepts a prompt on stdin and exits when
  done. Interactive multi-turn CLI sessions (the normal Claude Code REPL) will
  need a different approach — likely a persistent PTY per project instead of
  spawn-per-prompt. This is the single biggest unknown in the whole spec and
  worth prototyping in isolation before building anything on top of it.
- No auth. This is built to run on localhost only.
- Git sync is pull-based (button click), not a file watcher. Fine for
  single-user local use; would need `fs.watch` or a git hook for "live."
