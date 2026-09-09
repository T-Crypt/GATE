---
layout: default
title: Event log
permalink: /docs/events/
---

Commands, evidence, runs, and issue changes all land in one append-only event stream. The stream is the source of truth for the UI and the MCP interface alike.

Events are append-only and ordered by `(project_id, sequence)`. Every command appends its event and updates the read model in the same transaction, so the stream is a complete, gap-free record of what happened.

## Record structure

Each event records:

| Field | Meaning |
| --- | --- |
| `id` | UUID identifying the event |
| `project_id`, `sequence` | Per-project ordering; sequence increments by one per project |
| `type` | Event type (see families below) |
| `schema_version` | Payload schema version, defaults to 1 |
| `actor { type, id }` | Who caused it — `human`, `agent`, or `mcp` |
| `correlation_id` | Groups events from one logical operation |
| `causation_id` | The event that directly triggered this one, when any |
| `payload_json` | Type-specific payload |
| `created_at` | Timestamp |

## Replay and live delivery

The UI subscribes over WebSocket at `/ws?projectId=<id>&after=<sequence>`. On connect the server sends a `hello` (protocol version 1), then replays up to 1,000 missed durable events in sequence order, then streams new durable events as they commit, ephemeral provider activity messages, and a heartbeat every 15 seconds. A client that drops and reconnects with its last delivered sequence gets exactly the events it missed — already-delivered sequences are skipped, so there are no duplicates.

## Event families

| Family | Current types |
| --- | --- |
| `project.*` | `project.created`, `project.policy.updated` |
| `timeline.*` | `timeline.draft.proposed`, `timeline.replaced`, `timeline.node.transitioned` |
| `agent.run.*` | `agent.run.started`, `agent.run.interrupted` |
| `gate.*` | `gate.evidence.submitted`, `gate.approval.decided` |
| `issue.*` | `issue.created`, `issue.status.updated` |
| `note.*` | `note.created` |
| `git.*` | `git.history.observed` |

## Consumer guidance

Consumers must ignore unknown event types and use `schema_version` when adding incompatible payloads — the stream grows without breaking older readers.