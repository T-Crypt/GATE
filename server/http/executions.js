import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';

export function executionsRouter(execution) {
  const router = Router();
  router.get('/projects/:projectId/runs', (req, res) =>
    data(res, execution.list(Number(req.params.projectId)))
  );
  router.get('/projects/:projectId/activity', (req, res) =>
    data(res, execution.activityFeed(Number(req.params.projectId), Number(req.query.limit) || undefined))
  );
  router.get('/runs/:runId', (req, res) => data(res, execution.get(req.params.runId)));
  router.post('/projects/:projectId/runs/schedule', requireIdempotency, async (req, res) =>
    data(res, await execution.schedule(Number(req.params.projectId), commandContext(req)), 202)
  );
  router.post('/projects/:projectId/runs', requireIdempotency, async (req, res) => {
    const body = z.object({ nodeId: z.string().trim().min(1).max(200) }).parse(req.body);
    return data(
      res,
      await execution.start(Number(req.params.projectId), body.nodeId, commandContext(req)),
      202
    );
  });
  router.post('/runs/:runId/cancel', requireIdempotency, async (req, res) =>
    data(res, await execution.cancel(req.params.runId, commandContext(req)), 202)
  );
  return router;
}
