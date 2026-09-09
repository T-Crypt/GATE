import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDatabase, withTransaction } from '../../server/db/database.js';
import { migrate } from '../../server/db/migrate.js';
import { createTestDatabase } from '../helpers/database.js';

test('migrations create an immutable ordered event store', () => {
  const { db, close } = createTestDatabase();

  try {
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'memory');

    const columns = db
      .prepare('PRAGMA table_info(events)')
      .all()
      .map((row) => row.name);

    assert.deepEqual(columns, [
      'id',
      'project_id',
      'sequence',
      'type',
      'schema_version',
      'actor_type',
      'actor_id',
      'correlation_id',
      'causation_id',
      'payload_json',
      'created_at'
    ]);
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      10
    );
    assert.ok(
      db.prepare('PRAGMA table_info(memory_nodes)').all().some((column) => column.name === 'source_path')
    );
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_search'").get()
    );
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_capsules'").get()
    );
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'features'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'planning_requests'").get());
  } finally {
    close();
  }
});

test('withTransaction rolls back every write on failure', () => {
  const { db, close } = createTestDatabase();

  try {
    assert.throws(
      () =>
        withTransaction(db, () => {
          db.prepare("INSERT INTO app_meta(key, value) VALUES ('sample', 'one')").run();
          throw new Error('stop');
        }),
      /stop/
    );

    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key = 'sample'").get(),
      undefined
    );
  } finally {
    close();
  }
});

test('migration preserves legacy projects while adding safety policy', () => {
  const db = openDatabase({ filename: ':memory:' });
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      agent_cmd TEXT DEFAULT 'claude',
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO projects(name, repo_path) VALUES ('Existing project', '/tmp/existing');
  `);

  try {
    migrate(db);
    const project = db.prepare('SELECT * FROM projects WHERE id = 1').get();
    assert.equal(project.name, 'Existing project');
    assert.equal(project.base_branch, 'main');
    assert.deepEqual(JSON.parse(project.protected_branches_json), ['main']);
    assert.equal(project.interaction_level, 'assist');
  } finally {
    db.close();
  }
});
