# GATE documentation index

This directory holds GATE's internal engineering docs. User-facing documentation — setup & operations, architecture, project intelligence, provider adapters, MCP, events, and troubleshooting — is published on the docs site at **[t-crypt.github.io/GATE](https://t-crypt.github.io/GATE)** and maintained under [`../site/docs/`](../site/docs/).

Here:

| File / dir | Purpose |
| --- | --- |
| [`project-intelligence-status.md`](project-intelligence-status.md) | The implementation boundary of the project-intelligence slices: what ships at the current phase, what is deliberately not shipped yet, and the next clean boundary. |
| [`specs/`](specs/) | Design specs recorded before implementation. `2026-09-09-feature-planning-design.md` is the Phase 5 spec that shipped as durable Feature workspaces and planning requests. |
| [`reference/`](reference/) | Route map from each internal topic to the equivalent published page. |
| [`assets/`](assets/) | Shared artwork (the README hero banner). |

The published site is the single source of truth for reference content, so reference topics are **not** duplicated here. When a design decision becomes shipped behavior, move it into the relevant `site/docs/` page and keep `project-intelligence-status.md` current. The boundary rule from the phase docs still applies: SQLite is authoritative, and nothing under `.gate/` is ever imported back.