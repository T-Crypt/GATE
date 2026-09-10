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

function graphFixture() {
  const repository = createGitFixture();
  fs.mkdirSync(path.join(repository.repoPath, 'core'), { recursive: true });
  fs.mkdirSync(path.join(repository.repoPath, 'isolated'), { recursive: true });
  fs.writeFileSync(path.join(repository.repoPath, 'core', 'kernel.js'), 'export function dispatch() {}\n');
  for (const name of ['alpha', 'beta', 'gamma']) {
    fs.writeFileSync(
      path.join(repository.repoPath, 'core', `${name}.js`),
      `import { dispatch } from './kernel.js';\nexport function ${name}() { return dispatch(); }\n`
    );
  }
  fs.writeFileSync(path.join(repository.repoPath, 'isolated', 'leaf.js'), 'export function leaf() {}\n');
  fs.writeFileSync(
    path.join(repository.repoPath, 'isolated', 'branch.js'),
    "import { leaf } from './leaf.js';\nexport function branch() { return leaf(); }\n"
  );
  repository.run(['add', '.']);
  repository.run(['commit', '-m', 'add graph fixture']);
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events, new GitAdapter());
  const memory = new MemoryService({ db, projects, gitAdapter: new GitAdapter(), eventStore: events });
  const project = projects.create({ name: 'Graph fixture', repoPath: repository.repoPath }, context('create-graph'));
  return { repository, db, memory, project, close() { close(); repository.close(); } };
}

test('god nodes rank the highest fan-in module by recorded import degree', async () => {
  const fixture = graphFixture();
  try {
    await fixture.memory.refresh(fixture.project.id, { force: true }, context('graph-godnodes'));

    const central = fixture.memory.godNodes(fixture.project.id, { edgeTypes: ['IMPORTS'] });

    assert.deepEqual(central.edgeTypes, ['IMPORTS']);
    assert.equal(central.truncated, false);
    assert.equal(central.items[0].path, 'core/kernel.js');
    assert.equal(central.items[0].inDegree, 3);
    assert.equal(central.items[0].outDegree, 0);
    assert.equal(central.items[0].sourceLocation, 'core/kernel.js');
    assert.ok(central.items.every((node) => node.degree > 0));
    assert.deepEqual(central.items.map((node) => node.degree), [...central.items.map((node) => node.degree)].sort((left, right) => right - left));
  } finally { fixture.close(); }
});

test('communities separate modules that share no recorded import or reference edge', async () => {
  const fixture = graphFixture();
  try {
    await fixture.memory.refresh(fixture.project.id, { force: true }, context('graph-communities'));

    const grouped = fixture.memory.communities(fixture.project.id);

    assert.deepEqual(grouped.edgeTypes, ['IMPORTS', 'REFERENCES']);
    assert.equal(grouped.count, 2);
    const paths = grouped.items.map((community) => new Set(community.members.map((node) => node.sourcePath || node.path)));
    const core = paths.find((set) => set.has('core/kernel.js'));
    const isolated = paths.find((set) => set.has('isolated/leaf.js'));
    assert.ok(core && isolated);
    assert.equal(core.has('isolated/leaf.js'), false);
    assert.equal(isolated.has('core/kernel.js'), false);
    assert.equal(grouped.items[0].size >= grouped.items[1].size, true);
    assert.ok(grouped.items.every((community) => community.label.length > 0));
  } finally { fixture.close(); }
});

test('memory path walks a recorded import chain and refuses to invent a missing link', async () => {
  const fixture = graphFixture();
  try {
    await fixture.memory.refresh(fixture.project.id, { force: true }, context('graph-path'));
    const alpha = fixture.memory.search(fixture.project.id, { query: 'core/alpha.js', type: 'file' }).items[0];
    const kernel = fixture.memory.search(fixture.project.id, { query: 'core/kernel.js', type: 'file' }).items[0];
    const leaf = fixture.memory.search(fixture.project.id, { query: 'isolated/leaf.js', type: 'file' }).items[0];

    const found = fixture.memory.path(fixture.project.id, alpha.id, kernel.id, { edgeTypes: ['IMPORTS'] });

    assert.equal(found.hops, 1);
    assert.deepEqual(found.nodes.map((node) => node.path), ['core/alpha.js', 'core/kernel.js']);
    assert.deepEqual(found.edges.map((edge) => edge.type), ['IMPORTS']);
    assert.equal(found.edges[0].provenance.origin, 'static_parser');
    assert.throws(
      () => fixture.memory.path(fixture.project.id, alpha.id, leaf.id, { edgeTypes: ['IMPORTS', 'REFERENCES'] }),
      (error) => error.code === 'MEMORY_PATH_NOT_FOUND' && error.status === 404
    );
    assert.throws(() => fixture.memory.path(fixture.project.id, alpha.id, 'memory:1:file:missing'), /was not found/);
  } finally { fixture.close(); }
});

test('memory explain cites the recorded edges and provenance behind a node', async () => {
  const fixture = graphFixture();
  try {
    await fixture.memory.refresh(fixture.project.id, { force: true }, context('graph-explain'));
    const symbol = fixture.memory.search(fixture.project.id, { query: 'dispatch', type: 'symbol' }).items[0];

    const explained = fixture.memory.explain(fixture.project.id, symbol.id, { query: 'dispatch' });
    const neighborhood = fixture.memory.neighbors(fixture.project.id, symbol.id, { depth: 1 });
    const recordedEdgeIds = new Set(neighborhood.edges.map((edge) => edge.id));

    assert.equal(explained.matched, true);
    assert.equal(explained.sourceLocation, 'core/kernel.js:1');
    assert.equal(explained.provenance.origin, 'static_parser');
    assert.ok(explained.matchReasons.length > 0);
    assert.ok(explained.relationships.length > 0);
    assert.ok(explained.relationships.every((relation) => recordedEdgeIds.has(relation.edgeId)));
    assert.ok(explained.relationships.some((relation) => relation.type === 'CONTAINS' && relation.direction === 'incoming'));
    assert.ok(explained.relationships.some((relation) => relation.type === 'REFERENCES'));
    assert.match(explained.summary, /static source parsing/);
    assert.throws(() => fixture.memory.explain(fixture.project.id, 'memory:1:symbol:missing'), /was not found/);
  } finally { fixture.close(); }
});

test('memory query answers from indexed nodes only and cites every claim', async () => {
  const fixture = graphFixture();
  try {
    await fixture.memory.refresh(fixture.project.id, { force: true }, context('graph-query'));

    const answered = fixture.memory.query(fixture.project.id, { question: 'what depends on dispatch?', budget: 4000 });
    const indexed = new Set(
      fixture.db.prepare('SELECT id FROM memory_nodes WHERE project_id = ?').all(fixture.project.id).map((row) => row.id)
    );

    assert.ok(answered.citations.length > 0);
    assert.ok(answered.citations.every((item) => indexed.has(item.nodeId)));
    assert.ok(answered.citations.every((item) => item.sourceLocation));
    assert.ok(answered.statements.every((statement) => statement.nodeIds.every((id) => indexed.has(id))));
    assert.ok(answered.edges.every((edge) => indexed.has(edge.sourceNodeId) && indexed.has(edge.targetNodeId)));
    assert.match(answered.answer, /dispatch/);
    assert.match(answered.answer, /Structural impact is/);
    assert.ok(answered.estimatedTokens <= answered.tokenBudget);

    const trimmed = fixture.memory.query(fixture.project.id, { question: 'what depends on dispatch?', budget: 256 });
    assert.equal(trimmed.truncated, true);
    assert.ok(trimmed.citations.length < answered.citations.length);
    assert.ok(trimmed.citations.every((item) => indexed.has(item.nodeId)));

    const unknown = fixture.memory.query(fixture.project.id, { question: 'zzzznonexistentsymbol' });
    assert.deepEqual(unknown.citations, []);
    assert.match(unknown.answer, /no indexed node/i);
    assert.throws(() => fixture.memory.query(fixture.project.id, { question: '  ' }), /question is required/);
  } finally { fixture.close(); }
});
