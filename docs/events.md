# Event log

Events are append-only and ordered by `(project_id, sequence)`. Each event records schema version, actor, correlation, causation, payload, and timestamp. WebSocket clients reconnect with their last sequence and replay missed durable events before receiving ephemeral provider output.

Current families include `project.*`, `timeline.*`, `agent.run.*`, `gate.*`, `issue.*`, `note.*`, and `git.*`. Consumers must ignore unknown event types and use `schema_version` when adding incompatible payloads.
