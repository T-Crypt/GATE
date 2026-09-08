import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createHttpServer } from '../../server/adapters/live-events.js';
import { createApp } from '../../server/app.js';
import { buildServices } from '../../server/composition.js';
import { loadConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { migrate } from '../../server/db/migrate.js';
import { FakeProvider } from './fake-provider.js';

const dataDir = '/tmp/gate-browser-data';
const repoPath = '/tmp/gate-browser-project';
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(repoPath, { recursive: true, force: true });
fs.mkdirSync(repoPath, { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'Gate Browser Test'], { cwd: repoPath });
execFileSync('git', ['config', 'user.email', 'browser@localhost'], { cwd: repoPath });
fs.writeFileSync(path.join(repoPath, 'README.md'), '# Browser fixture\n');
execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'ignore' });
execFileSync('git', ['branch', 'stable'], { cwd: repoPath });
execFileSync('git', ['branch', 'production'], { cwd: repoPath });

const config = loadConfig({ GATE_DATA_DIR: dataDir, PORT: '4207', HOST: '127.0.0.1' });
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.worktreeDir, { recursive: true });
const db = openDatabase({ filename: config.databaseFile });
migrate(db);
const services = buildServices({
  db,
  config,
  providers: new Map([['claude', new FakeProvider({ delayMs: 1200 })]])
});
const app = createApp({ services, config });
const server = createHttpServer({ app, eventStore: services.events, heartbeatMs: 1000 });
server.listen(config.port, config.host, () => process.stdout.write('browser test server ready\n'));

function stop() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
