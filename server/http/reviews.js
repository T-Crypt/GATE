import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';

const evidenceInput = z.object({
  kind: z.string().trim().min(1).max(80),
  headSha: z.string().trim().min(1).max(256),
  fileScope: z.array(z.string().trim().min(1).max(4096)).max(250).default([]),
  command: z.string().trim().max(4096).nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
  output: z.string().max(100_000).default(''),
  artifactPath: z.string().trim().max(4096).nullable().optional()
});
const decisionInput = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(10_000).default('')
});

export function reviewsRouter(reviews) {
  const router = Router();
  router.get('/projects/:projectId/review', (req, res) =>
    data(res, reviews.get(Number(req.params.projectId)))
  );
  router.post('/projects/:projectId/gates/:gateId/evidence', requireIdempotency, (req, res) =>
    data(res, reviews.submitEvidence(Number(req.params.projectId), req.params.gateId,
      evidenceInput.parse(req.body), commandContext(req)), 201)
  );
  router.post('/projects/:projectId/gates/:gateId/decisions', requireIdempotency, (req, res) =>
    data(res, reviews.decide(Number(req.params.projectId), req.params.gateId,
      decisionInput.parse(req.body), commandContext(req)), 201)
  );
  return router;
}
