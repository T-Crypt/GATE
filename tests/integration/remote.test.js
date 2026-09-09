import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';

import { createApp } from '../../server/app.js';
import { EventStore } from '../../server/application/event-store.js';
import { ProjectService } from '../../server/application/project-service.js';
import { GitAdapter } from '../../server/adapters/git.js';
import { RemoteService } from '../../server/application/remote-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { createGitFixture } from '../helpers/git.js';

const context = (key) => ({ actor: { type: 'human', id: 'remote' }, correlationId: key, idempotencyKey: key });

class StubRemote {
  resolve(_repoPath, origin) {
    return { owner: 'T-Crypt', repo: 'GATE' };
  }
  async listPullRequests() {
    return [{ number: 1, title: 'PR one', state: 'open', draft: false, headRef: 'feat/a', baseRef: 'main', author: 'u', body: null, htmlUrl: 'https://x/1', updatedAt: '2026-09-08T00:00:00Z' }];
  }
  async listIssues() {
    return [{ number: 2, title: 'Issue two', state: 'open', labels: ['bug'], assignee: null, htmlUrl: 'https://x/2', updatedAt: '2026-09-08T00:00:00Z' }];
  }
}

function setup({ configured = true } = {}) {
  const database = createTestDatabase();
  const events = new EventStore(database.db);
  const gitFixture = createGitFixture();
  const projects = new ProjectService(database.db, events, new GitAdapter());
  const gitFixtureWithOrigin = gitFixture;
  gitFixtureWithOrigin.run(['remote', 'add', 'origin', 'https://github.com/T-Crypt/GATE.git']);
  const config = {
    jsonLimit: '20kb',
    githubToken: configured ? 'test-token' : '',
    githubApiUrl: 'https://api.github.com'
  };
  const services = {
    events,
    projects,
    timeline: { get: () => ({ nodes: [], edges: [] }) },
    execution: { list: () => [] },
    reviews: { get: () => ({ gates: [], evidence: [], approvals: [] }) },
    dashboard: { summary: () => ({ issues: [], notes: [], gitEvents: [] }), branches: async () => ['main'] },
    remote: new RemoteService(database.db, events, projects, new GitAdapter(), new StubRemote(), config)
  };
  return {
    ...database,
    app: createApp({ services, config }),
    services,
    git: gitFixtureWithOrigin
  };
}

test('remote status reports configured and cached counts', async () => {
  const fixture = setup();
  try {
    const created = await fixture.services.projects.create(
      { name: 'Remote', repoPath: fixture.git.repoPath },
      context('create')
    );
    await fixture.services.remote.syncPullRequests(created.id, context('pr-sync'));
    await fixture.services.remote.syncIssues(created.id, context('issue-sync'));

    const response = await request(fixture.app).get(`/api/v1/projects/${created.id}/remote/status`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.configured, true);
    assert.equal(response.body.data.prCount, 1);
    assert.equal(response.body.data.issueCount, 1);
  } finally {
    fixture.close();
    fixture.git.close();
  }
});

test('sync round-trips pull requests and repo issues over HTTP', async () => {
  const fixture = setup();
  try {
    const created = await fixture.services.projects.create(
      { name: 'Remote', repoPath: fixture.git.repoPath },
      context('create-2')
    );
    const response = await request(fixture.app)
      .post(`/api/v1/projects/${created.id}/remote/sync`)
      .set('Idempotency-Key', 'remote-sync-1');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.prs.length, 1);
    assert.equal(response.body.data.prs[0].headRef, 'feat/a');
    assert.equal(response.body.data.issues.length, 1);
    assert.equal(response.body.data.issues[0].labels[0], 'bug');
  } finally {
    fixture.close();
    fixture.git.close();
  }
});

test('sync is rejected when no token is configured', async () => {
  const fixture = setup({ configured: false });
  try {
    const created = await fixture.services.projects.create(
      { name: 'Remote', repoPath: fixture.git.repoPath },
      context('create-3')
    );
    const response = await request(fixture.app)
      .post(`/api/v1/projects/${created.id}/remote/sync`)
      .set('Idempotency-Key', 'remote-sync-2');
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'REMOTE_NOT_CONFIGURED');
  } finally {
    fixture.close();
    fixture.git.close();
  }
});