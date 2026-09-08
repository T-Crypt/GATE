import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';

const issueInput = z.object({
  title: z.string().trim().min(1).max(500),
  branch: z.string().trim().max(250).nullable().optional()
});
const issueUpdate = z.object({ status: z.enum(['open', 'in_progress', 'closed']) });
const noteInput = z.object({
  body: z.string().trim().min(1).max(10_000),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([])
});

export function dashboardRouter(dashboard) {
  const router = Router();
  router.get('/projects/:projectId/dashboard', async (req, res) =>
    data(res, await dashboard.summary(Number(req.params.projectId)))
  );
  router.post('/projects/:projectId/issues', requireIdempotency, (req, res) =>
    data(res, dashboard.addIssue(Number(req.params.projectId), issueInput.parse(req.body), commandContext(req)), 201)
  );
  router.patch('/projects/:projectId/issues/:issueId', requireIdempotency, (req, res) =>
    data(res, dashboard.updateIssue(Number(req.params.projectId), Number(req.params.issueId), issueUpdate.parse(req.body), commandContext(req)))
  );
  router.post('/projects/:projectId/notes', requireIdempotency, (req, res) =>
    data(res, dashboard.addNote(Number(req.params.projectId), noteInput.parse(req.body), commandContext(req)), 201)
  );
  router.post('/projects/:projectId/git/sync', requireIdempotency, async (req, res) =>
    data(res, await dashboard.syncGit(Number(req.params.projectId), commandContext(req)))
  );
  return router;
}
