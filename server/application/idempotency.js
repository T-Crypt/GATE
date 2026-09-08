import crypto from 'node:crypto';

import { withTransaction } from '../db/database.js';
import { AppError } from '../domain/errors.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function requestHash(request) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(request))).digest('hex');
}

export function runIdempotent(db, context, request, operation) {
  if (!context?.actor?.id || !context?.idempotencyKey) {
    throw new AppError('IDEMPOTENCY_REQUIRED', 'Actor and idempotency key are required', {
      status: 400
    });
  }

  const hash = requestHash(request);
  return withTransaction(db, () => {
    const existing = db
      .prepare('SELECT request_hash, result_json FROM idempotency_keys WHERE actor_id = ? AND idempotency_key = ?')
      .get(context.actor.id, context.idempotencyKey);

    if (existing) {
      if (existing.request_hash !== hash) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for another command',
          { status: 409 }
        );
      }
      return JSON.parse(existing.result_json);
    }

    const result = operation();
    db.prepare(
      `INSERT INTO idempotency_keys(actor_id, idempotency_key, request_hash, result_json)
       VALUES (?, ?, ?, ?)`
    ).run(context.actor.id, context.idempotencyKey, hash, JSON.stringify(result));
    return result;
  });
}
