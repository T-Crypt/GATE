import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';

import { AppError } from '../domain/errors.js';

export function requestContext(req, res, next) {
  const supplied = req.get('X-Request-Id');
  req.requestId = supplied && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
}

export function commandContext(req) {
  return {
    actor: { type: 'human', id: 'local-web' },
    correlationId: req.requestId,
    idempotencyKey: req.get('Idempotency-Key') || ''
  };
}

export function requireIdempotency(req, _res, next) {
  if (!req.get('Idempotency-Key')) {
    return next(
      new AppError('IDEMPOTENCY_REQUIRED', 'Idempotency-Key header is required', { status: 400 })
    );
  }
  next();
}

export function data(res, value, status = 200, meta = {}) {
  return res.status(status).json({ data: value, meta: { apiVersion: 'v1', ...meta } });
}

export function notFoundHandler(req, _res, next) {
  next(new AppError('ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`, { status: 404 }));
}

export function errorHandler(error, req, res, _next) {
  let normalized = error;
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    normalized = new AppError('INVALID_JSON', 'Request body is not valid JSON', { status: 400 });
  }
  if (error instanceof ZodError) {
    normalized = new AppError('VALIDATION_FAILED', 'Request validation failed', {
      status: 422,
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
  }
  if (!(normalized instanceof AppError)) {
    req.log?.error?.({ err: error, requestId: req.requestId }, 'unhandled request error');
    normalized = new AppError('INTERNAL_ERROR', 'The request could not be completed', {
      status: 500
    });
  }

  res.status(normalized.status).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      requestId: req.requestId,
      ...(normalized.details === undefined ? {} : { details: normalized.details })
    }
  });
}
