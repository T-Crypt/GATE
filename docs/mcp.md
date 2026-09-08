# MCP interface

Start with `npm run mcp`. Read tools list projects, timelines, runs, review bundles, and the recent activity feed. Mutation tools require an `idempotencyKey` and can draft/accept timelines, start/schedule/cancel steps, replace editable graph data, submit evidence, create or update issues, and add notes.

There is no MCP approval tool. This is intentional: an agent can report evidence but cannot impersonate the human review gate. There are also no merge, push, or protected-branch mutation tools.
