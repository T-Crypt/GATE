import { randomUUID } from 'node:crypto';

import { afterCommit, withTransaction } from '../db/database.js';
import { AppError } from '../domain/errors.js';

function decode(row) {
  if (!row) return row;
  return {
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    type: row.type,
    schemaVersion: row.schema_version,
    actor: { type: row.actor_type, id: row.actor_id },
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at
  };
}

export class EventStore {
  constructor(db) {
    this.db = db;
    this.listeners = new Map();
    this.liveListeners = new Map();
  }

  append(input, project = () => {}) {
    const actor = input.actor;
    if (!input.projectId || !input.type || !actor?.type || !actor?.id) {
      throw new AppError('INVALID_EVENT', 'Project, type, and actor are required');
    }

    return withTransaction(this.db, () => {
      const sequenceRow = this.db
        .prepare(
          `UPDATE projects
           SET last_sequence = last_sequence + 1, updated_at = datetime('now')
           WHERE id = ?
           RETURNING last_sequence`
        )
        .get(input.projectId);
      if (!sequenceRow) {
        throw new AppError('PROJECT_NOT_FOUND', `Project ${input.projectId} was not found`, {
          status: 404
        });
      }

      const id = randomUUID();
      const correlationId = input.correlationId || id;
      this.db
        .prepare(
          `INSERT INTO events(
             project_id, sequence, type, schema_version, actor_type, actor_id,
             correlation_id, causation_id, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          sequenceRow.last_sequence,
          input.type,
          input.schemaVersion || 1,
          actor.type,
          actor.id,
          correlationId,
          input.causationId || null,
          JSON.stringify(input.payload ?? {})
        );

      const event = decode(
        this.db.prepare('SELECT * FROM events WHERE project_id = ? AND sequence = ?').get(
          input.projectId,
          sequenceRow.last_sequence
        )
      );
      project(event);
      afterCommit(this.db, () => this.#publish(event));
      return event;
    });
  }

  readAfter(projectId, sequence = 0, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
    return this.db
      .prepare(
        `SELECT * FROM events
         WHERE project_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`
      )
      .all(projectId, sequence, safeLimit)
      .map(decode);
  }

  subscribe(projectId, listener) {
    const key = Number(projectId);
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
    return () => {
      const listeners = this.listeners.get(key);
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(key);
    };
  }

  subscribeLive(projectId, listener) {
    const key = Number(projectId);
    if (!this.liveListeners.has(key)) this.liveListeners.set(key, new Set());
    this.liveListeners.get(key).add(listener);
    return () => {
      const listeners = this.liveListeners.get(key);
      listeners?.delete(listener);
      if (listeners?.size === 0) this.liveListeners.delete(key);
    };
  }

  publishLive(projectId, activity) {
    for (const listener of this.liveListeners.get(Number(projectId)) || []) listener(activity);
  }

  #publish(event) {
    for (const listener of this.listeners.get(Number(event.projectId)) || []) listener(event);
  }
}
