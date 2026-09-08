---
layout: page
title: MCP interface
permalink: /docs/mcp/
---

Start with `npm run mcp`. The server uses stdio and the same SQLite-backed services as the web UI.

**Read tools** list projects, timelines, runs, review bundles, the recent activity feed, and skill status (`skills_status`).

**Mutation tools** require an `idempotencyKey` and can:

- draft or accept timelines
- start, schedule, or cancel steps
- replace editable graph data
- submit evidence
- create or update issues
- add notes
- install the bundled Gate Claude skill into a project repository at `.claude/skills/gate/SKILL.md` (`skills_install`)

There is no MCP approval tool. This is intentional: an agent can report evidence but cannot impersonate the human review gate. There are also no merge, push, or protected-branch mutation tools.
