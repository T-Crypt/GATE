import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';

const branch = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).max(250).nullable().optional()
);
const projectInput = z.object({
  name: z.string().trim().min(1).max(120),
  repoPath: z.string().trim().min(1).max(4096),
  baseBranch: z.string().trim().min(1).max(250).default('main'),
  productionBranch: branch,
  stableBranch: branch,
  protectedBranches: z.array(z.string().trim().min(1).max(250)).max(50).default([]),
  interactionLevel: z.enum(['observe', 'assist', 'automatic', 'custom']).default('assist'),
  providerKind: z.string().trim().min(1).max(80).default('claude'),
  providerConfig: z.record(z.string(), z.unknown()).default({})
});

const policyInput = projectInput
  .pick({
    baseBranch: true,
    productionBranch: true,
    stableBranch: true,
    protectedBranches: true,
    interactionLevel: true
  })
  .partial();

export function projectsRouter(projects) {
  const router = Router();
  router.get('/projects', (_req, res) => data(res, projects.list()));
  router.get('/projects/:projectId', (req, res) => data(res, projects.get(Number(req.params.projectId))));
  router.post('/projects', requireIdempotency, (req, res) => {
    const project = projects.create(projectInput.parse(req.body), commandContext(req));
    return data(res, project, 201);
  });
  router.patch('/projects/:projectId/policy', requireIdempotency, (req, res) => {
    const project = projects.updatePolicy(
      Number(req.params.projectId),
      policyInput.parse(req.body),
      commandContext(req)
    );
    return data(res, project);
  });
  return router;
}
