import { Router } from 'express';

import { data } from './middleware.js';

export function dashboardRouter(dashboard) {
  const router = Router();
  router.get('/projects/:projectId/dashboard', (req, res) =>
    data(res, dashboard.summary(Number(req.params.projectId)))
  );
  return router;
}
