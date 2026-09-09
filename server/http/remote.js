import { Router } from 'express';

import { commandContext, data, requireIdempotency } from './middleware.js';

export function remoteRouter(remote) {
  const router = Router();
  router.get('/projects/:projectId/remote/status', (req, res) => {
    return data(res, remote.status(Number(req.params.projectId)));
  });
  router.get('/projects/:projectId/remote/prs', (req, res) => {
    return data(res, remote.pullRequests(Number(req.params.projectId)));
  });
  router.get('/projects/:projectId/remote/issues', (req, res) => {
    return data(res, remote.issues(Number(req.params.projectId)));
  });
  router.post('/projects/:projectId/remote/sync', requireIdempotency, async (req, res, next) => {
    try {
      const projectId = Number(req.params.projectId);
      const context = commandContext(req);
      return data(res, await remote.sync(projectId, context));
    } catch (error) {
      return next(error);
    }
  });
  return router;
}
