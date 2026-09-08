import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GitAdapter } from '../../server/adapters/git.js';
import { ProcessRunner } from '../../server/adapters/providers/process-runner.js';
import { DashboardService } from '../../server/application/dashboard-service.js';
import { EventStore } from '../../server/application/event-store.js';
import { ExecutionService } from '../../server/application/execution-service.js';
import { ProjectService } from '../../server/application/project-service.js';
import { TimelineService } from '../../server/application/timeline-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { createGitFixture } from '../helpers/git.js';

const fixtureScript = fileURLToPath(new URL('../fixtures/fake-claude.js', import.meta.url));

function context(key) {
  return {
    actor: { type: 'human', id: 'test-user' },
    correlationId: `correlation-${key}`,
    idempotencyKey: key
  };
}

function timelineGraph() {
  return {
    nodes: [
      { id: 'milestone-a', key: 'A', kind: 'milestone', title: 'Build', ordinal: 0 },
      {
        id: 'ready-step',
        key: 'A-1',
        kind: 'step',
        parentId: 'milestone-a',
        title: 'Ready work',
        description: 'Implement the ready work',
        ordinal: 0
      },
      {
        id: 'blocked-step',
        key: 'A-2',
        kind: 'step',
        parentId: 'milestone-a',
        title: 'Blocked work',
        ordinal: 1
      }
    ],
    edges: [
      {
        id: 'ready-blocks-next',
        fromNodeId: 'ready-step',
        toNodeId: 'blocked-step',
        type: 'depends_on'
      }
    ],
    gates: []
  };
}

function setup(provider = new FakeProvider()) {
  const gitFixture = createGitFixture();
  const database = createTestDatabase();
  const events = new EventStore(database.db);
  const projects = new ProjectService(database.db, events);
  const timeline = new TimelineService(database.db, events);
  const project = projects.create(
    {
      name: 'Execution fixture',
      repoPath: gitFixture.repoPath,
      baseBranch: 'main',
      protectedBranches: ['main'],
      interactionLevel: 'automatic'
    },
    context('create-project')
  );
  timeline.replaceDraft(project.id, timelineGraph(), context('create-timeline'));
  const execution = new ExecutionService({
    db: database.db,
    eventStore: events,
    projectService: projects,
    timelineService: timeline,
    gitAdapter: new GitAdapter(),
    providers: new Map([['claude', provider]]),
    worktreeDir: gitFixture.worktreeParent,
    outputLimitBytes: 50_000
  });
  return { ...database, events, execution, gitFixture, project, projects, provider, timeline };
}

test('automatic mode starts only ready nodes in the assigned worktree', async () => {
  const fixture = setup();
  try {
    const runs = await fixture.execution.schedule(fixture.project.id, context('schedule'));

    assert.deepEqual(runs.map((run) => run.nodeId), ['ready-step']);
    assert.equal(fixture.provider.requests[0].cwd, runs[0].worktreePath);
    assert.equal(fixture.provider.requests[0].nodeKey, 'A-1');
    assert.notEqual(fixture.provider.requests[0].cwd, fixture.gitFixture.repoPath);
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('direct execution cannot bypass an incomplete dependency', async () => {
  const fixture = setup();
  try {
    await assert.rejects(
      () => fixture.execution.start(fixture.project.id, 'blocked-step', context('direct-blocked')),
      (error) => error.code === 'STEP_BLOCKED'
    );
    assert.equal(fixture.provider.requests.length, 0);
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('provider launch never interpolates prompt text through a shell', async () => {
  const gitFixture = createGitFixture();
  const marker = path.join(gitFixture.root, 'must-not-exist');
  const output = [];
  const runner = new ProcessRunner();

  try {
    const running = await runner.start(
      {
        executable: process.execPath,
        args: [fixtureScript],
        cwd: gitFixture.repoPath,
        input: `hello; touch ${marker}`,
        env: {},
        outputLimitBytes: 20_000
      },
      { onOutput: (chunk) => output.push(chunk) }
    );
    const result = await running.completion;

    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(marker), false);
    assert.match(output.join(''), /hello; touch/);
  } finally {
    gitFixture.close();
  }
});

test('a drafted timeline remains proposed until explicitly accepted', async () => {
  const fixture = setup();
  try {
    fixture.timeline.replaceDraft(
      fixture.project.id,
      { nodes: [], edges: [], gates: [] },
      context('clear-timeline')
    );
    const draft = await fixture.execution.draftTimeline(
      fixture.project.id,
      'Ship the workstation',
      context('draft-timeline')
    );

    assert.equal(draft.status, 'proposed');
    assert.equal(fixture.timeline.get(fixture.project.id).nodes.length, 0);

    const accepted = fixture.execution.acceptDraft(
      fixture.project.id,
      draft.id,
      context('accept-draft')
    );
    assert.equal(accepted.status, 'accepted');
    assert.equal(fixture.timeline.get(fixture.project.id).nodes[0].key, 'A');
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('activity feed reports runs with their originating step title', async () => {
  const fixture = setup();
  try {
    const runs = await fixture.execution.schedule(fixture.project.id, context('schedule-feed'));
    assert.equal(runs.length, 1);

    const feed = fixture.execution.activityFeed(fixture.project.id);
    assert.equal(feed.runs.length, 1);
    assert.equal(feed.runs[0].nodeTitle, 'Ready work');
    assert.equal(feed.runs[0].nodeKey, 'A-1');
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('drafting a timeline sends the synced project digest as repository context', async () => {
  const provider = new FakeProvider();
  const fixture = setup(provider);
  try {
    const dashboard = new DashboardService(fixture.db, fixture.events, fixture.projects, new GitAdapter());
    await dashboard.syncGit(fixture.project.id, context('sync-for-digest'));

    await fixture.execution.draftTimeline(
      fixture.project.id,
      'Add a login page',
      context('draft-with-digest')
    );

    assert.equal(provider.draftRequests.length, 1);
    assert.match(provider.draftRequests[0].repositoryContext, /Files:\nREADME\.md/);
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});
