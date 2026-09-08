import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });

const db = openDatabase({ filename: config.databaseFile });
migrate(db);

export default db;
