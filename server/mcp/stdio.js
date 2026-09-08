import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildServices } from '../composition.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { createMcpServer } from './server.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDatabase({ filename: config.databaseFile });
migrate(db);
const services = buildServices({ db, config });
const server = createMcpServer(services);
const transport = new StdioServerTransport();

await server.connect(transport);

async function shutdown() {
  await server.close();
  db.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
