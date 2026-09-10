import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';
import { AppError } from '../domain/errors.js';

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
  branchPrefix: z.string().trim().max(250).default('work/gate-'),
  interactionLevel: z.enum(['observe', 'assist', 'automatic', 'custom']).default('assist'),
  stage: z.enum(['greenfield', 'active', 'maintenance']).default('active'),
  providerKind: z.string().trim().min(1).max(80).default('claude'),
  providerConfig: z.record(z.string(), z.unknown()).default({})
});

const policyInput = projectInput
  .pick({
    baseBranch: true,
    productionBranch: true,
    stableBranch: true,
    protectedBranches: true,
    branchPrefix: true,
    interactionLevel: true
  })
  .partial();

const providerInput = z
  .object({
    providerKind: z.string().trim().min(1).max(80).optional(),
    providerConfig: z.record(z.string(), z.unknown()).optional()
  })
  .refine((value) => value.providerKind !== undefined || value.providerConfig !== undefined);

const stageInput = z.object({
  stage: z.enum(['greenfield', 'active', 'maintenance'])
});

const instructionInput = z.object({
  userContent: z.string().max(100_000)
});

export function projectsRouter(projects, instructions, providerMap) {
  const router = Router();
  router.get('/projects', (_req, res) => data(res, projects.list()));
  router.get('/projects/:projectId', (req, res) => data(res, projects.get(Number(req.params.projectId))));
  router.post('/projects/inspect', async (req, res, next) => {
    try {
      const parsed = z.object({ repoPath: z.string().trim().min(1).max(4096) }).parse(req.body);
      return data(res, await projects.inspect(parsed));
    } catch (error) {
      return next(error);
    }
  });
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
  router.get('/providers/:kind/models', async (req, res) => {
    const provider = providerMap?.get(req.params.kind);
    if (!provider) throw new AppError('UNKNOWN_PROVIDER', `No provider named ${req.params.kind}`, { status: 404 });
    if (!provider.listModels) return data(res, { kind: req.params.kind, authenticated: false, models: [] });
    return data(res, { kind: req.params.kind, ...(await provider.listModels()) });
  });
  router.patch('/projects/:projectId/provider', requireIdempotency, async (req, res) => {
    const input = providerInput.parse(req.body);
    // A model the harness cannot reach fails at draft time, ~30s in, with a
    // 502 the user cannot act on. Reject it here instead.
    const model = input.providerConfig?.model;
    if (model) {
      const kind = input.providerKind ?? projects.get(Number(req.params.projectId)).providerKind;
      const provider = providerMap?.get(kind);
      const catalog = provider?.listModels ? await provider.listModels() : { models: [] };
      // A provider whose CLI cannot enumerate models reports `complete: false`:
      // its list is a suggestion, so rejecting an id that is missing from it
      // would block models the harness can reach perfectly well.
      const known = catalog.complete === false ? [] : catalog.models;
      if (known.length && !known.some((candidate) => candidate.id === model)) {
        throw new AppError('UNKNOWN_MODEL', `${kind} cannot reach the model "${model}"`, {
          status: 422,
          details: { model, available: known.map((candidate) => candidate.id) }
        });
      }
    }
    const project = projects.updateProvider(Number(req.params.projectId), input, commandContext(req));
    return data(res, project);
  });
  router.patch('/projects/:projectId/stage', requireIdempotency, (req, res) => {
    const project = projects.updateStage(
      Number(req.params.projectId),
      stageInput.parse(req.body),
      commandContext(req)
    );
    return data(res, project);
  });
  if (instructions) {
    router.get('/projects/:projectId/instructions', (req, res) =>
      data(res, instructions.list(Number(req.params.projectId)))
    );
    router.get('/projects/:projectId/instructions/:fileName', (req, res) =>
      data(res, instructions.get(Number(req.params.projectId), req.params.fileName))
    );
    router.put('/projects/:projectId/instructions/:fileName', requireIdempotency, (req, res) =>
      data(
        res,
        instructions.update(
          Number(req.params.projectId),
          { fileName: req.params.fileName, ...instructionInput.parse(req.body) },
          commandContext(req)
        )
      )
    );
  }
  return router;
}
