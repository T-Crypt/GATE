import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dashboardRouter } from './http/dashboard.js';
import { executionsRouter } from './http/executions.js';
import {
  data,
  errorHandler,
  notFoundHandler,
  requestContext
} from './http/middleware.js';
import { projectsRouter } from './http/projects.js';
import { remoteRouter } from './http/remote.js';
import { reviewsRouter } from './http/reviews.js';
import { timelineRouter } from './http/timeline.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(moduleDir, '..', 'public');

export function createApp({ services, config, logger, routes = true }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          fontSrc: ["'self'", 'data:']
        }
      }
    })
  );
  app.use(requestContext);
  app.use(express.json({ limit: config.jsonLimit }));
  if (logger) {
    app.use((req, _res, next) => {
      req.log = logger.child({ requestId: req.requestId });
      next();
    });
  }

  app.get('/health', (_req, res) => data(res, { process: 'healthy' }));
  app.get('/ready', (_req, res, next) => {
    try {
      services.events.db.prepare('SELECT 1').get();
      return data(res, { database: 'ready' });
    } catch (error) {
      return next(error);
    }
  });

  if (routes) {
    app.use('/api/v1', projectsRouter(services.projects));
    app.use('/api/v1', timelineRouter(services.timeline, services.execution));
    app.use('/api/v1', executionsRouter(services.execution));
    app.use('/api/v1', reviewsRouter(services.reviews));
    app.use('/api/v1', dashboardRouter(services.dashboard));
    if (services.remote) {
      app.use('/api/v1', remoteRouter(services.remote));
    }
  }

  app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
