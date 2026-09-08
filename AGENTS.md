# Agent instructions

- Work only on a `feature/*` or `fix/*` branch in an isolated linked worktree.
- Never merge, rebase, push, delete, or rewrite `main`, the selected base branch, stable, or production.
- Use red-green-refactor TDD for behavior changes and run `npm run check` before handoff.
- Preserve event plus projection atomicity. All mutations must be idempotent application commands.
- Keep providers behind the provider adapter; Claude is first, not hardwired into the domain.
- Store local evidence under `data/tests/<project-id>/`. Do not add telemetry or cloud dependencies.
- A human must review every branch and is the only actor allowed to approve gates or integrate work.
