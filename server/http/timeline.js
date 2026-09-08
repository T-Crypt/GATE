import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';

const graph = z.object({
  nodes: z.array(z.record(z.string(), z.unknown())).max(2000),
  edges: z.array(z.record(z.string(), z.unknown())).max(5000),
  gates: z.array(z.record(z.string(), z.unknown())).max(5000).default([])
});

export function timelineRouter(timeline, execution) {
  const router = Router();
  router.get('/projects/:projectId/timeline', (req, res) =>
    data(res, timeline.get(Number(req.params.projectId)))
  );
  router.put('/projects/:projectId/timeline', requireIdempotency, (req, res) =>
    data(
      res,
      timeline.replaceDraft(
        Number(req.params.projectId),
        graph.parse(req.body),
        commandContext(req)
      )
    )
  );
  router.post('/projects/:projectId/timeline/drafts', requireIdempotency, async (req, res) => {
    const body = z.object({ goal: z.string().trim().min(3).max(20_000) }).parse(req.body);
    return data(
      res,
      await execution.draftTimeline(Number(req.params.projectId), body.goal, commandContext(req)),
      201
    );
  });
  router.post('/projects/:projectId/timeline/drafts/:draftId/accept', requireIdempotency, (req, res) =>
    data(
      res,
      execution.acceptDraft(
        Number(req.params.projectId),
        req.params.draftId,
        commandContext(req)
      )
    )
  );
  router.patch('/projects/:projectId/timeline/nodes/:nodeId', requireIdempotency, (req, res) => {
    const body = z
      .object({ status: z.string().optional(), locked: z.boolean().optional() })
      .refine((value) => value.status !== undefined || value.locked !== undefined)
      .parse(req.body);
    const projectId = Number(req.params.projectId);
    const result =
      body.locked !== undefined
        ? timeline.setLocked(projectId, req.params.nodeId, body.locked, commandContext(req))
        : timeline.transition(projectId, req.params.nodeId, body.status, commandContext(req));
    return data(res, result);
  });
  return router;
}
