import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import request from 'supertest';

import { createApp } from '../../server/app.js';
import { EventStore } from '../../server/application/event-store.js';
import { ContextCompiler } from '../../server/application/context-compiler.js';
import { InstructionService } from '../../server/application/instruction-service.js';
import { ProjectService } from '../../server/application/project-service.js';
import { MemoryService } from '../../server/application/memory-service.js';
import { GitAdapter } from '../../server/adapters/git.js';
import { TimelineService } from '../../server/application/timeline-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { createGitFixture } from '../helpers/git.js';

function setup() {
  const database = createTestDatabase();
  const events = new EventStore(database.db);
  const projects = new ProjectService(database.db, events);
  const git = new GitAdapter();
  const memory = new MemoryService({ db: database.db, projects, gitAdapter: git, eventStore: events });
  const timeline = new TimelineService(database.db, events);
  const instructions = new InstructionService({ db: database.db, projects, eventStore: events });
  const contexts = new ContextCompiler({ db: database.db, projects, memory, instructions, gitAdapter: git, eventStore: events });
  const services = {
    events,
    projects,
    instructions,
    memory,
    contexts,
    timeline,
    execution: {
      list: () => [],
      activityFeed: () => ({ runs: [], activity: [] }),
      schedule: async () => [],
      start: async () => {},
      cancel: async () => {},
      draftTimeline: async () => {},
      acceptDraft: () => {}
    },
    reviews: { get: () => ({ gates: [], evidence: [], approvals: [] }) },
    dashboard: { summary: () => ({ issues: [], notes: [], gitEvents: [] }) }
  };
  return {
    ...database,
    app: createApp({ services, config: { jsonLimit: '20kb' } }),
    services
  };
}

test('validation errors use a stable envelope and request id', async () => {
  const fixture = setup();
  try {
    const response = await request(fixture.app)
      .post('/api/v1/projects')
      .set('Idempotency-Key', 'invalid-project')
      .send({ name: '' });

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'VALIDATION_FAILED');
    assert.ok(response.body.error.requestId);
    assert.equal(response.headers['x-request-id'], response.body.error.requestId);
  } finally {
    fixture.close();
  }
});

test('project creation returns a versioned data envelope', async () => {
  const gitFixture = createGitFixture();
  const fixture = setup();
  try {
    const response = await request(fixture.app)
      .post('/api/v1/projects')
      .set('Idempotency-Key', 'create-project')
      .send({
        name: 'Workbench',
        repoPath: gitFixture.repoPath,
        baseBranch: 'main',
        stableBranch: 'stable',
        productionBranch: 'production'
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.name, 'Workbench');
    assert.deepEqual(response.body.data.protectedBranches, ['main', 'production', 'stable']);
    assert.equal(response.body.meta.apiVersion, 'v1');
  } finally {
    fixture.close();
    gitFixture.close();
  }
});

test('project creation accepts empty optional branch fields from an unfilled form', async () => {
  const gitFixture = createGitFixture();
  const fixture = setup();
  try {
    const response = await request(fixture.app)
      .post('/api/v1/projects')
      .set('Idempotency-Key', 'create-project-empty-branches')
      .send({
        name: 'Minimal',
        repoPath: gitFixture.repoPath,
        baseBranch: 'main',
        stableBranch: '',
        productionBranch: ''
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.stableBranch, null);
    assert.equal(response.body.data.productionBranch, null);
  } finally {
    fixture.close();
    gitFixture.close();
  }
});

test('project stage and managed instructions are available through guarded project routes', async () => {
  const gitFixture = createGitFixture();
  const fixture = setup();
  try {
    const created = await request(fixture.app)
      .post('/api/v1/projects')
      .set('Idempotency-Key', 'create-stage-project')
      .send({ name: 'Workbench', repoPath: gitFixture.repoPath, baseBranch: 'main' });
    const projectId = created.body.data.id;

    const updated = await request(fixture.app)
      .patch(`/api/v1/projects/${projectId}/stage`)
      .set('Idempotency-Key', 'set-maintenance')
      .send({ stage: 'maintenance' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.stage, 'maintenance');

    const missing = await request(fixture.app).get(`/api/v1/projects/${projectId}/instructions/AGENTS.md`);
    assert.equal(missing.status, 200);
    assert.equal(missing.body.data.status, 'missing');

    const saved = await request(fixture.app)
      .put(`/api/v1/projects/${projectId}/instructions/AGENTS.md`)
      .set('Idempotency-Key', 'save-instructions')
      .send({ userContent: '# Project rules\n\nKeep changes test-backed.' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.status, 'valid');
    assert.match(saved.body.data.content, /GATE:MANAGED:START/);
  } finally {
    fixture.close();
    gitFixture.close();
  }
});

test('memory routes refresh and search the local file graph', async () => {
  const gitFixture = createGitFixture();
  const fixture = setup();
  try {
    fs.mkdirSync(path.join(gitFixture.repoPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(gitFixture.repoPath, 'src', 'provider.js'),
      'export function stream() {}\n// Emits streaming chunks to the configured harness.\n'
    );
    fs.writeFileSync(
      path.join(gitFixture.repoPath, 'src', 'consumer.js'),
      "import { stream } from './provider.js';\nexport const consume = () => stream();\n"
    );
    gitFixture.run(['add', '.']);
    gitFixture.run(['commit', '-m', 'add API memory fixture']);
    const created = await request(fixture.app)
      .post('/api/v1/projects')
      .set('Idempotency-Key', 'create-memory-project')
      .send({ name: 'Memory project', repoPath: gitFixture.repoPath, baseBranch: 'main' });
    const projectId = created.body.data.id;

    const refreshed = await request(fixture.app)
      .post(`/api/v1/projects/${projectId}/memory/refresh`)
      .set('Idempotency-Key', 'refresh-memory-project')
      .send({ force: true });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.data.mode, 'full');

    const search = await request(fixture.app).get(`/api/v1/projects/${projectId}/memory/search?q=README`);
    assert.equal(search.status, 200);
    assert.ok(search.body.data.items.some((item) => item.path === 'README.md'));

    const symbols = await request(fixture.app).get(`/api/v1/projects/${projectId}/memory/search?q=stream&type=symbol`);
    assert.equal(symbols.status, 200);
    assert.deepEqual(symbols.body.data.items.map((item) => item.name), ['stream']);

    const semantic = await request(fixture.app).get(`/api/v1/projects/${projectId}/memory/search?q=emits+configured+harness`);
    assert.equal(semantic.status, 200);
    assert.equal(semantic.body.data.items[0].path, 'src/provider.js');
    assert.equal(semantic.body.data.items[0].matchStrategy, 'semantic');

    const neighborhood = await request(fixture.app).get(
      `/api/v1/projects/${projectId}/memory/nodes/${encodeURIComponent(symbols.body.data.items[0].id)}/neighbors?depth=2&edgeTypes=REFERENCES`
    );
    assert.equal(neighborhood.status, 200);
    assert.deepEqual(neighborhood.body.data.edgeTypes, ['REFERENCES']);
    assert.ok(neighborhood.body.data.edges.every((edge) => edge.type === 'REFERENCES'));

    const impact = await request(fixture.app).get(`/api/v1/projects/${projectId}/memory/impact?q=stream`);
    assert.equal(impact.status, 200);
    assert.deepEqual(impact.body.data.dependents.map((item) => item.path), ['src/consumer.js']);
    assert.ok(impact.body.data.edges.some((edge) => edge.type === 'REFERENCES'));

    const compiled = await request(fixture.app)
      .post(`/api/v1/projects/${projectId}/memory/context`)
      .set('Idempotency-Key', 'compile-memory-context')
      .send({ goal: 'Change provider streaming behavior', kind: 'planning', tokenBudget: 1200 });
    assert.equal(compiled.status, 201);
    assert.equal(compiled.body.data.kind, 'planning');
    assert.ok(compiled.body.data.estimatedTokens <= 1200);
    assert.ok(compiled.body.data.provenance.sourceFiles.includes('src/provider.js'));

    const listed = await request(fixture.app).get(`/api/v1/projects/${projectId}/memory/context`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data[0].id, compiled.body.data.id);

    const fetched = await request(fixture.app).get(
      `/api/v1/projects/${projectId}/memory/context/${compiled.body.data.id}`
    );
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.contentHash, compiled.body.data.contentHash);
  } finally {
    fixture.close();
    gitFixture.close();
  }
});

test('activity feed route returns the execution service payload', async () => {
  const fixture = setup();
  try {
    fixture.services.execution.activityFeed = (projectId, limit) => ({
      runs: [{ id: 'run-1', projectId, nodeTitle: 'Step', nodeKey: 'A-1' }],
      activity: [],
      limit
    });
    const response = await request(fixture.app).get('/api/v1/projects/1/activity?limit=10');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.runs[0].nodeTitle, 'Step');
    assert.equal(response.body.data.limit, 10);
  } finally {
    fixture.close();
  }
});

test('readiness distinguishes process health from service readiness', async () => {
  const fixture = setup();
  try {
    assert.equal((await request(fixture.app).get('/health')).status, 200);
    const ready = await request(fixture.app).get('/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.data.database, 'ready');
  } finally {
    fixture.close();
  }
});
