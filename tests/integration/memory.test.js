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
    assert.equal(status.qualityLevel, 3);
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

test('memory impact follows symbol references through production dependents to tests', async () => {
  const repository = createGitFixture();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events, new GitAdapter());
  const memory = new MemoryService({ db, projects, gitAdapter: new GitAdapter(), eventStore: events });

  try {
    fs.mkdirSync(path.join(repository.repoPath, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repository.repoPath, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repository.repoPath, 'src', 'core.js'), 'export function stream() {}\n');
    fs.writeFileSync(
      path.join(repository.repoPath, 'src', 'adapter.js'),
      "import { stream } from './core.js';\nexport function adapt() { return stream(); }\n"
    );
    fs.writeFileSync(
      path.join(repository.repoPath, 'tests', 'adapter.test.js'),
      "import { adapt } from '../src/adapter.js';\ntest('adapter', () => adapt());\n"
    );
    repository.run(['add', '.']);
    repository.run(['commit', '-m', 'add impact fixture']);
    const project = projects.create({ name: 'Impact fixture', repoPath: repository.repoPath }, context('create-impact'));
    await memory.refresh(project.id, { force: true }, context('memory-impact-refresh'));

    const impact = memory.impact(project.id, { query: 'stream' });

    assert.deepEqual(impact.directMatches.map((node) => node.name), ['stream']);
    assert.deepEqual(impact.declaringFiles.map((node) => node.path), ['src/core.js']);
    assert.deepEqual(impact.dependents.map((node) => node.path), ['src/adapter.js']);
    assert.deepEqual(impact.tests.map((node) => node.path), ['tests/adapter.test.js']);
    assert.deepEqual(impact.symbols.map((node) => node.name), ['stream']);
    assert.equal(impact.risk, 'low');
    assert.ok(impact.edges.some((edge) => edge.type === 'REFERENCES'));
    assert.ok(impact.edges.some((edge) => edge.type === 'IMPORTS'));
    assert.ok(impact.edges.every((edge) => edge.provenance.origin === 'static_parser'));
    assert.match(impact.reasons[impact.dependents[0].id].join(' '), /imports|references/i);
    assert.equal(new Set(impact.tests.map((node) => node.id)).size, impact.tests.length);
  } finally {
    close();
    repository.close();
  }
});

test('memory search combines exact graph matches with local source-content retrieval', async () => {
  const repository = createGitFixture();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events, new GitAdapter());
  const memory = new MemoryService({ db, projects, gitAdapter: new GitAdapter(), eventStore: events });

  try {
    fs.mkdirSync(path.join(repository.repoPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository.repoPath, 'src', 'execution-policy.js'),
      "export function abortRun() {}\n// Terminate a running provider process after cancellation.\n"
    );
    repository.run(['add', '.']);
    repository.run(['commit', '-m', 'add semantic fixture']);
    const project = projects.create({ name: 'Semantic fixture', repoPath: repository.repoPath }, context('create-semantic'));
    await memory.refresh(project.id, { force: true }, context('memory-semantic-refresh'));

    const semantic = memory.search(project.id, { query: 'terminate running provider' });
    const exact = memory.search(project.id, { query: 'abortRun' });
    const status = await memory.status(project.id);

    assert.equal(semantic.items[0].path, 'src/execution-policy.js');
    assert.equal(semantic.items[0].matchStrategy, 'semantic');
    assert.ok(semantic.items[0].matchReasons.some((reason) => /source content/i.test(reason)));
    assert.equal(exact.items[0].type, 'symbol');
    assert.equal(exact.items[0].name, 'abortRun');
    assert.equal(exact.items[0].matchStrategy, 'hybrid');
    assert.ok(exact.items[0].score > semantic.items[0].score);
    assert.equal(status.qualityLevel, 3);
    assert.ok(status.counts.documents >= 2);

    fs.writeFileSync(
      path.join(repository.repoPath, 'src', 'execution-policy.js'),
      "export function finishRun() {}\n// Complete active execution cleanly.\n"
    );
    repository.run(['add', '.']);
    repository.run(['commit', '-m', 'replace semantic terms']);
    await memory.refresh(project.id, {}, context('memory-semantic-incremental'));

    assert.equal(memory.search(project.id, { query: 'terminate running provider' }).items.length, 0);
    assert.equal(memory.search(project.id, { query: 'finishRun' }).items[0].name, 'finishRun');
  } finally {
    close();
    repository.close();
  }
});

test('memory neighborhoods can be restricted to deterministic relationship types', async () => {
  const repository = createGitFixture();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events, new GitAdapter());
  const memory = new MemoryService({ db, projects, gitAdapter: new GitAdapter(), eventStore: events });

  try {
    fs.mkdirSync(path.join(repository.repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repository.repoPath, 'src', 'core.js'), 'export function serve() {}\n');
    fs.writeFileSync(path.join(repository.repoPath, 'src', 'api.js'), "import { serve } from './core.js';\nserve();\n");
    repository.run(['add', '.']);
    repository.run(['commit', '-m', 'add neighborhood fixture']);
    const project = projects.create({ name: 'Neighborhood fixture', repoPath: repository.repoPath }, context('create-neighborhood'));
    await memory.refresh(project.id, { force: true }, context('memory-neighborhood-refresh'));
    const symbol = memory.search(project.id, { query: 'serve', type: 'symbol' }).items[0];

    const graph = memory.neighbors(project.id, symbol.id, { depth: 2, edgeTypes: ['REFERENCES'] });

    assert.deepEqual(graph.edgeTypes, ['REFERENCES']);
    assert.ok(graph.edges.length > 0);
    assert.ok(graph.edges.every((edge) => edge.type === 'REFERENCES'));
    assert.deepEqual(graph.nodes.filter((node) => node.type === 'file').map((node) => node.path), ['src/api.js']);
    assert.throws(
      () => memory.neighbors(project.id, symbol.id, { edgeTypes: ['INFERRED_BY_MODEL'] }),
      /edge type/i
    );
  } finally {
    close();
    repository.close();
  }
});
