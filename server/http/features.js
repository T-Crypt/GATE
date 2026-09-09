import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';

const planInput = z.object({ model: z.string().trim().max(200).optional(), tokenBudget: z.number().int().min(512).max(32_000).optional() });

export function featuresRouter(features, planner) {
  const router = Router();
  router.get('/projects/:projectId/features', (req, res) => data(res, features.list(Number(req.params.projectId))));
  router.post('/projects/:projectId/features', requireIdempotency, (req, res) => data(res, features.create(Number(req.params.projectId), z.object({ title: z.string().trim().min(1).max(500), intent: z.string().trim().min(1).max(20_000) }).parse(req.body), commandContext(req)), 201));
  router.get('/projects/:projectId/features/:featureId', (req, res) => data(res, features.get(Number(req.params.projectId), req.params.featureId)));
  router.get('/projects/:projectId/features/:featureId/plans', (req, res) => data(res, planner.list(Number(req.params.projectId), 'feature', req.params.featureId)));
  router.patch('/projects/:projectId/features/:featureId', requireIdempotency, (req, res) => data(res, features.transition(Number(req.params.projectId), req.params.featureId, z.object({ status: z.enum(['idea','planning','approved','in_progress','blocked','review','complete','cancelled']) }).parse(req.body).status, commandContext(req))));
  router.post('/projects/:projectId/features/:featureId/plan', requireIdempotency, async (req, res) => data(res, await planner.plan(Number(req.params.projectId), { ...planInput.parse(req.body), sourceType: 'feature', sourceId: req.params.featureId }, commandContext(req)), 201));
  router.post('/projects/:projectId/issues/:issueId/plan', requireIdempotency, async (req, res) => data(res, await planner.plan(Number(req.params.projectId), { ...planInput.parse(req.body), sourceType: 'issue', sourceId: req.params.issueId }, commandContext(req)), 201));
  router.post('/projects/:projectId/timeline/nodes/:milestoneId/expansions', requireIdempotency, async (req, res) => data(res, await planner.expandMilestone(Number(req.params.projectId), req.params.milestoneId, planInput.parse(req.body), commandContext(req)), 201));
  router.get('/projects/:projectId/planning/:requestId', (req, res) => data(res, planner.get(Number(req.params.projectId), req.params.requestId)));
  router.post('/projects/:projectId/planning/:requestId/accept', requireIdempotency, (req, res) => data(res, planner.accept(Number(req.params.projectId), req.params.requestId, commandContext(req))));
  return router;
}
