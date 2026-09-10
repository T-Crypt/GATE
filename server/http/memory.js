import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';

const edgeTypesQuery = z.string().trim().max(200).optional();

function splitEdgeTypes(value) {
  return value ? value.split(',').map((type) => type.trim()).filter(Boolean) : undefined;
}

export function memoryRouter(memory, contexts) {
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
    const query = z.object({
      depth: z.coerce.number().int().positive().max(4).optional(),
      edgeTypes: edgeTypesQuery
    }).parse(req.query);
    return data(res, memory.neighbors(Number(req.params.projectId), req.params.nodeId, { depth: query.depth, edgeTypes: splitEdgeTypes(query.edgeTypes) }));
  });
  router.get('/projects/:projectId/memory/impact', (req, res) => {
    const query = z.object({ q: z.string().trim().min(1).max(500), limit: z.coerce.number().int().positive().max(25).optional() }).parse(req.query);
    return data(res, memory.impact(Number(req.params.projectId), { query: query.q, limit: query.limit }));
  });
  router.get('/projects/:projectId/memory/nodes/:nodeId/explain', (req, res) => {
    const query = z.object({ q: z.string().trim().min(1).max(500).optional() }).parse(req.query);
    return data(res, memory.explain(Number(req.params.projectId), req.params.nodeId, { query: query.q }));
  });
  router.get('/projects/:projectId/memory/god-nodes', (req, res) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(100).optional(), edgeTypes: edgeTypesQuery }).parse(req.query);
    return data(res, memory.godNodes(Number(req.params.projectId), { limit: query.limit, edgeTypes: splitEdgeTypes(query.edgeTypes) }));
  });
  router.get('/projects/:projectId/memory/communities', (req, res) => {
    const query = z.object({
      limit: z.coerce.number().int().positive().max(50).optional(),
      members: z.coerce.number().int().positive().max(100).optional(),
      edgeTypes: edgeTypesQuery
    }).parse(req.query);
    return data(res, memory.communities(Number(req.params.projectId), { limit: query.limit, members: query.members, edgeTypes: splitEdgeTypes(query.edgeTypes) }));
  });
  router.get('/projects/:projectId/memory/path', (req, res) => {
    const query = z.object({
      from: z.string().trim().min(1).max(500),
      to: z.string().trim().min(1).max(500),
      maxHops: z.coerce.number().int().positive().max(6).optional(),
      edgeTypes: edgeTypesQuery
    }).parse(req.query);
    return data(res, memory.path(Number(req.params.projectId), query.from, query.to, { maxHops: query.maxHops, edgeTypes: splitEdgeTypes(query.edgeTypes) }));
  });
  router.get('/projects/:projectId/memory/query', (req, res) => {
    const query = z.object({
      q: z.string().trim().min(1).max(2000),
      budget: z.coerce.number().int().min(256).max(32_000).optional()
    }).parse(req.query);
    return data(res, memory.query(Number(req.params.projectId), { question: query.q, budget: query.budget }));
  });
  if (contexts) {
    router.get('/projects/:projectId/memory/context', (req, res) => {
      const query = z.object({ limit: z.coerce.number().int().positive().max(100).optional() }).parse(req.query);
      return data(res, contexts.list(Number(req.params.projectId), query.limit));
    });
    router.get('/projects/:projectId/memory/context/:capsuleId', (req, res) =>
      data(res, contexts.get(Number(req.params.projectId), req.params.capsuleId))
    );
    router.post('/projects/:projectId/memory/context', requireIdempotency, async (req, res, next) => {
      try {
        const body = z.object({
          goal: z.string().trim().min(3).max(20_000),
          kind: z.enum(['context', 'planning', 'execution']).default('context'),
          tokenBudget: z.number().int().min(512).max(32_000).default(4000)
        }).parse(req.body);
        return data(res, await contexts.compile(Number(req.params.projectId), body, commandContext(req)), 201);
      } catch (error) {
        return next(error);
      }
    });
  }
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
