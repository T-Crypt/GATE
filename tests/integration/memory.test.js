import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { GitAdapter } from '../../server/adapters/git.js';
import { EventStore } from '../../server/application/event-store.js';
import { MemoryService } from '../../server/application/memory-service.js';
import { ProjectService } from '../../server/application/project-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { createGitFixture } from '../helpers/git.js';

function context(idempotencyKey) {
  return {
    actor: { type: 'human', id: 'test-user' },
    correlationId: 'correlation-memory',
    idempotencyKey
  };
}

test('memory refresh builds a local file graph while excluding secrets and .gateignore paths', async () => {
  const repository = createGitFixture();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events, new GitAdapter());
  const memory = new MemoryService({ db, projects, gitAdapter: new GitAdapter(), eventStore: events });

  try {
    fs.mkdirSync(path.join(repository.repoPath, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repository.repoPath, 'private'), { recursive: true });
    fs.writeFileSync(path.join(repository.repoPath, 'src', 'server.js'), 'export function serve() {}\n');
    fs.writeFileSync(
      path.join(repository.repoPath, 'src', 'server.test.js'),
      "import { serve } from './server.js';\ntest('serve', () => serve());\n"
    );
    fs.writeFileSync(path.join(repository.repoPath, '.env'), 'SECRET=value\n');
    fs.writeFileSync(path.join(repository.repoPath, 'private', 'notes.md'), 'do not index\n');
    fs.writeFileSync(path.join(repository.repoPath, '.gateignore'), 'private/\n');
    repository.run(['add', '.']);
    repository.run(['commit', '-m', 'add memory fixture']);
    const project = projects.create({ name: 'Memory fixture', repoPath: repository.repoPath }, context('create'));

    const refreshed = await memory.refresh(project.id, { force: true }, context('memory-refresh'));
    const status = await memory.status(project.id);
    const search = memory.search(project.id, { query: 'server', limit: 10 });
    const symbolSearch = memory.search(project.id, { query: 'serve', limit: 10, type: 'symbol' });

    assert.equal(refreshed.mode, 'full');
    assert.equal(status.stale, false);
    assert.equal(status.qualityLevel, 2);
    assert.ok(status.counts.files >= 3);
    assert.ok(search.items.some((item) => item.path === 'src/server.js'));
    assert.equal(search.items.some((item) => item.path === '.env'), false);
    assert.equal(search.items.some((item) => item.path === 'private/notes.md'), false);
    assert.deepEqual(symbolSearch.items.map((item) => ({ name: item.name, sourcePath: item.sourcePath })), [
      { name: 'serve', sourcePath: 'src/server.js' }
    ]);
    assert.equal(symbolSearch.items[0].provenance.origin, 'static_parser');
    const symbolGraph = memory.neighbors(project.id, symbolSearch.items[0].id, { depth: 1 });
    assert.ok(symbolGraph.edges.some((edge) => edge.type === 'CONTAINS'));
    assert.ok(symbolGraph.edges.some((edge) => edge.type === 'REFERENCES'));
    assert.ok(symbolGraph.nodes.some((node) => node.path === 'src/server.test.js'));
    assert.equal(events.readAfter(project.id, 0, 20).at(-1).type, 'memory.index.completed');
  } finally {
    close();
    repository.close();
  }
});

test('memory refresh updates only Git-changed paths after the initial index', async () => {
  const repository = createGitFixture();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events, new GitAdapter());
  const memory = new MemoryService({ db, projects, gitAdapter: new GitAdapter(), eventStore: events });

  try {
    const project = projects.create({ name: 'Memory fixture', repoPath: repository.repoPath }, context('create-incremental'));
    await memory.refresh(project.id, { force: true }, context('memory-initial'));
    fs.mkdirSync(path.join(repository.repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repository.repoPath, 'src', 'new-module.js'), 'export const value = 1;\n');
    repository.run(['add', '.']);
    repository.run(['commit', '-m', 'add module']);

    const refreshed = await memory.refresh(project.id, {}, context('memory-incremental'));
    const search = memory.search(project.id, { query: 'new-module', limit: 10 });

    assert.equal(refreshed.mode, 'incremental');
    assert.ok(refreshed.changedPaths.includes('src/new-module.js'));
    assert.ok(search.items.some((item) => item.path === 'src/new-module.js'));

    fs.writeFileSync(path.join(repository.repoPath, 'src', 'new-module.js'), 'export const replacement = 2;\n');
    repository.run(['add', '.']);
    repository.run(['commit', '-m', 'replace exported symbol']);
    await memory.refresh(project.id, {}, context('memory-replace-symbol'));

    assert.equal(memory.search(project.id, { query: 'value', type: 'symbol' }).items.length, 0);
    assert.deepEqual(
      memory.search(project.id, { query: 'replacement', type: 'symbol' }).items.map((item) => item.name),
      ['replacement']
    );
  } finally {
    close();
    repository.close();
  }
});
