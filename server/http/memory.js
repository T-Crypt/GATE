import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';

export function memoryRouter(memory) {
  const router = Router();
  router.get('/projects/:projectId/memory/status', async (req, res, next) => {
    try {
      return data(res, await memory.status(Number(req.params.projectId)));
    } catch (error) {
      return next(error);
    }
  });
  router.get('/projects/:projectId/memory/search', (req, res) => {
    const query = z.object({
      q: z.string().trim().min(1).max(500),
      limit: z.coerce.number().int().positive().max(100).optional(),
      type: z.enum(['file', 'directory', 'repository', 'symbol']).optional()
    }).parse(req.query);
    return data(res, memory.search(Number(req.params.projectId), { query: query.q, ...query }));
  });
  router.get('/projects/:projectId/memory/nodes/:nodeId/neighbors', (req, res) => {
    const query = z.object({ depth: z.coerce.number().int().positive().max(4).optional() }).parse(req.query);
    return data(res, memory.neighbors(Number(req.params.projectId), req.params.nodeId, query));
  });
  router.get('/projects/:projectId/memory/impact', (req, res) => {
    const query = z.object({ q: z.string().trim().min(1).max(500), limit: z.coerce.number().int().positive().max(25).optional() }).parse(req.query);
    return data(res, memory.impact(Number(req.params.projectId), { query: query.q, limit: query.limit }));
  });
  router.post('/projects/:projectId/memory/refresh', requireIdempotency, async (req, res, next) => {
    try {
      const body = z.object({ force: z.boolean().default(false) }).parse(req.body);
      return data(res, await memory.refresh(Number(req.params.projectId), body, commandContext(req)));
    } catch (error) {
      return next(error);
    }
  });
  return router;
}
