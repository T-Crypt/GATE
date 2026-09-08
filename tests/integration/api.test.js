import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';

import { createApp } from '../../server/app.js';
import { EventStore } from '../../server/application/event-store.js';
import { ProjectService } from '../../server/application/project-service.js';
import { TimelineService } from '../../server/application/timeline-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { createGitFixture } from '../helpers/git.js';

function setup() {
  const database = createTestDatabase();
  const events = new EventStore(database.db);
  const projects = new ProjectService(database.db, events);
  const timeline = new TimelineService(database.db, events);
  const services = {
    events,
    projects,
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
