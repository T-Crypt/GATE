import { randomUUID } from 'node:crypto';

import { runIdempotent } from './idempotency.js';
import { AppError, notFound, validation } from '../domain/errors.js';

const TRANSITIONS = {
  idea: new Set(['planning', 'cancelled']),
  planning: new Set(['approved', 'blocked', 'cancelled']),
  approved: new Set(['in_progress', 'blocked', 'cancelled']),
  in_progress: new Set(['blocked', 'review', 'cancelled']),
  blocked: new Set(['planning', 'in_progress', 'cancelled']),
  review: new Set(['in_progress', 'blocked', 'complete']),
  complete: new Set(),
  cancelled: new Set()
};

function required(value, field, max) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw validation(`${field} must be between 1 and ${max} characters`, { field });
  return text;
}

function decode(row) {
  if (!row) return row;
  return { id: row.id, projectId: row.project_id, title: row.title, intent: row.intent, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class FeatureService {
  constructor(db, eventStore, projects) {
    this.db = db;
    this.events = eventStore;
    this.projects = projects;
  }

  create(projectId, input, context) {
    this.projects.get(projectId);
    const title = required(input.title, 'title', 500);
    const intent = required(input.intent, 'intent', 20_000);
    return runIdempotent(this.db, context, { command: 'feature.create', projectId, title, intent }, () => {
      const id = randomUUID();
      this.events.append({ projectId, type: 'feature.created', actor: context.actor, correlationId: context.correlationId, payload: { featureId: id, title } }, () => {
        this.db.prepare('INSERT INTO features(id, project_id, title, intent) VALUES (?, ?, ?, ?)').run(id, projectId, title, intent);
      });
      return this.get(projectId, id);
    });
  }

  get(projectId, featureId) {
    this.projects.get(projectId);
    const feature = decode(this.db.prepare('SELECT * FROM features WHERE project_id = ? AND id = ?').get(projectId, featureId));
    if (!feature) throw notFound('Feature', featureId);
    return feature;
  }

  list(projectId) {
    this.projects.get(projectId);
    return this.db.prepare('SELECT * FROM features WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC').all(projectId).map(decode);
  }

  transition(projectId, featureId, status, context) {
    const target = String(status ?? '').trim();
    if (!TRANSITIONS[target]) throw validation('Unknown feature status', { field: 'status' });
    return runIdempotent(this.db, context, { command: 'feature.transition', projectId, featureId, status: target }, () => {
      const feature = this.get(projectId, featureId);
      if (!TRANSITIONS[feature.status].has(target)) {
        throw new AppError('INVALID_FEATURE_TRANSITION', `Feature cannot move from ${feature.status} to ${target}`, { status: 409 });
      }
      this.events.append({ projectId, type: 'feature.status.updated', actor: context.actor, correlationId: context.correlationId, payload: { featureId, from: feature.status, to: target } }, () => {
        this.db.prepare("UPDATE features SET status = ?, updated_at = datetime('now') WHERE project_id = ? AND id = ?").run(target, projectId, featureId);
      });
      return this.get(projectId, featureId);
    });
  }
}
