# Internal reference map

Reference documentation for Gate lives on the published docs site — not in this directory — so there is exactly one canonical copy. Use the site path for each subject:

| Topic | Published |
| --- | --- |
| Setup & operations | <https://t-crypt.github.io/GATE/docs/setup/> |
| Architecture | <https://t-crypt.github.io/GATE/docs/architecture/> |
| Project intelligence (Memory, Context Compiler, feature planning) | <https://t-crypt.github.io/GATE/docs/project-intelligence/> |
| Provider adapters | <https://t-crypt.github.io/GATE/docs/providers/> |
| MCP interface | <https://t-crypt.github.io/GATE/docs/mcp/> |
| Event log | <https://t-crypt.github.io/GATE/docs/events/> |
| Troubleshooting | <https://t-crypt.github.io/GATE/docs/troubleshooting/> |

The agent skills shipped in `.claude/skills/gate/SKILL.md` and `.opencode/skills/gate/SKILL.md` link to the MCP reference on the site. If you change the MCP tool surface, update `site/docs/mcp.md` first; it drives those links.