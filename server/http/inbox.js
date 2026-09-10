import { Router } from 'express';
import { z } from 'zod';

import { commandContext, data, requireIdempotency } from './middleware.js';

const itemKey = z.string().trim().min(1).max(250);

export function inboxRouter(inbox) {
  const router = Router();
  router.get('/projects/:projectId/inbox', async (req, res, next) => {
    try {
      return data(res, await inbox.list(Number(req.params.projectId)));
    } catch (error) {
      return next(error);
    }
  });
  router.post('/projects/:projectId/inbox/:itemKey/dismiss', requireIdempotency, (req, res) =>
    data(res, inbox.dismiss(Number(req.params.projectId), itemKey.parse(req.params.itemKey), commandContext(req)), 201)
  );
  return router;
}
