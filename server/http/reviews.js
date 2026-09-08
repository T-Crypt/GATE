import { Router } from 'express';

import { data } from './middleware.js';

export function reviewsRouter(reviews) {
  const router = Router();
  router.get('/projects/:projectId/review', (req, res) =>
    data(res, reviews.get(Number(req.params.projectId)))
  );
  return router;
}
