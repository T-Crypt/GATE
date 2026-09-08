# MCP interface

Start with `npm run mcp`. Read tools list projects, timelines, runs, and review bundles. Mutation tools require an `idempotencyKey` and can draft/accept timelines, start/schedule/cancel steps, replace editable graph data, and submit evidence.

There is no MCP approval tool. This is intentional: an agent can report evidence but cannot impersonate the human review gate. There are also no merge, push, or protected-branch mutation tools.
