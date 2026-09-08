import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BackupService } from '../../server/application/backup-service.js';
import { buildServices } from '../../server/composition.js';
import { createTestDatabase } from '../helpers/database.js';
import { FakeProvider } from '../helpers/fake-provider.js';

test('restart marks an orphaned active run interrupted without advancing its node', () => {
  const database = createTestDatabase();
  try {
    database.db.prepare("INSERT INTO projects(id, name, repo_path, protected_branches_json) VALUES (1, 'P', '/tmp/p', '[\"main\"]')").run();
    database.db.prepare("INSERT INTO timeline_nodes(id, project_id, kind, title, display_key, status) VALUES ('step', 1, 'step', 'Step', 'A-1', 'running')").run();
    database.db.prepare("INSERT INTO runs(id, project_id, node_id, provider_kind, branch, worktree_path, base_sha, head_sha, status) VALUES ('run', 1, 'step', 'claude', 'work/run', '/tmp/run', 'a', 'a', 'running')").run();
    const services = buildServices({ db: database.db, config: { worktreeDir: '/tmp/work', outputLimitBytes: 1000 }, providers: new Map([['claude', new FakeProvider()]]) });

    const recovered = services.execution.recoverInterrupted();

    assert.equal(recovered[0].status, 'interrupted');
    assert.equal(services.timeline.get(1).nodes.find((node) => node.id === 'step').status, 'blocked');
    assert.equal(services.events.readAfter(1, 0, 20).at(-1).type, 'agent.run.interrupted');
  } finally {
    database.close();
  }
});

test('backup creates a checksummed SQLite copy and versioned JSON export', async () => {
  const database = createTestDatabase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-backup-'));
  try {
    database.db.prepare("INSERT INTO projects(name, repo_path, protected_branches_json) VALUES ('P', '/tmp/p', '[\"main\"]')").run();
    const backups = new BackupService(database.db);
    const sqlite = await backups.create(path.join(root, 'tracker.backup.db'));
    const exported = backups.exportJson(path.join(root, 'tracker.export.json'));

    assert.match(sqlite.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(sqlite.path), true);
    assert.equal(JSON.parse(fs.readFileSync(exported.path, 'utf8')).schemaVersion, 1);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
