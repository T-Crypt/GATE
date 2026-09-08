import fs from 'node:fs';
import pino from 'pino';

import { createHttpServer } from './adapters/live-events.js';
import { createApp } from './app.js';
import { buildServices } from './composition.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.validationDir, { recursive: true });
fs.mkdirSync(config.worktreeDir, { recursive: true });

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['req.headers.authorization', '*.token', '*.secret', '*.password', '*.apiKey'],
    censor: '[REDACTED]'
  }
});
const db = openDatabase({ filename: config.databaseFile });
const migrationVersion = migrate(db);
const services = buildServices({ db, config });
const recovered = services.execution.recoverInterrupted();
const app = createApp({ services, config, logger });
const server = createHttpServer({ app, eventStore: services.events });

if (config.allowRemoteBind) {
  logger.warn({ host: config.host }, 'Project MCP is configured beyond loopback');
}
if (recovered.length > 0) {
  logger.warn({ recoveredRuns: recovered.map((run) => run.id) }, 'Interrupted runs require review');
}

server.listen(config.port, config.host, () => {
  logger.info(
    { host: config.host, port: config.port, migrationVersion },
    'Project MCP workstation is ready'
  );
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Stopping Project MCP');
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref();
  server.close(() => {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
