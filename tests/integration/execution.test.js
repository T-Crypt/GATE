import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GitAdapter } from '../../server/adapters/git.js';
import { AppError } from '../../server/domain/errors.js';
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

test('a draft that violates the contract is retried once with the reason', async () => {
  // Seen in practice: the model pointed a code_gate edge at a gate id, which
  // normalization rejects as a dangling edge. A draft costs a full round-trip,
  // so the reason is fed back rather than lost.
  const attempts = [];
  const provider = new FakeProvider();
  provider.draftTimeline = async (request) => {
    attempts.push(request);
    if (attempts.length === 1) {
      return {
        nodes: [{ id: 'm1', key: 'A', kind: 'milestone', title: 'Build', ordinal: 0 }],
        edges: [{ fromNodeId: 'm1', toNodeId: 'gate-1', type: 'code_gate' }],
        gates: []
      };
    }
    return {
      nodes: [
        { id: 'm1', key: 'A', kind: 'milestone', title: 'Build', ordinal: 0 },
        { id: 's1', key: 'A-1', kind: 'step', parentId: 'm1', title: 'Ship', ordinal: 0 }
      ],
      edges: [{ fromNodeId: 'm1', toNodeId: 's1', type: 'depends_on' }],
      gates: []
    };
  };
  const fixture = setup(provider);
  try {
    const draft = await fixture.execution.draftTimeline(
      fixture.project.id,
      'Ship the workstation',
      context('draft-retry')
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].feedback, undefined);
    assert.match(attempts[1].feedback, /missing node/i);
    assert.equal(draft.status, 'proposed');
    assert.equal(draft.graph.nodes.length, 2);
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('a provider that answers with prose instead of JSON is retried with the reason', async () => {
  // Four of the six adapters only ever get the timeline contract as prose, so
  // an answer that is not JSON is the most likely way a draft fails. The CLI ran
  // and exited zero, so this is a contract violation, not an unreachable
  // provider — exactly what feeding the reason back is for.
  const attempts = [];
  const provider = new FakeProvider();
  provider.draftTimeline = async (request) => {
    attempts.push(request);
    if (attempts.length === 1) {
      throw new AppError('PROVIDER_OUTPUT_INVALID', 'Cursor returned invalid JSON', { status: 502 });
    }
    return {
      nodes: [
        { id: 'm1', key: 'A', kind: 'milestone', title: 'Build', ordinal: 0 },
        { id: 's1', key: 'A-1', kind: 'step', parentId: 'm1', title: 'Ship', ordinal: 0 }
      ],
      edges: [],
      gates: []
    };
  };
  const fixture = setup(provider);
  try {
    const draft = await fixture.execution.draftTimeline(fixture.project.id, 'Ship it', context('draft-prose'));
    assert.equal(attempts.length, 2);
    assert.match(attempts[1].feedback, /invalid JSON/i);
    assert.equal(draft.status, 'proposed');
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('a provider that cannot be launched is not retried', async () => {
  // The opposite case: retrying an absent CLI buys nothing and costs another
  // round-trip, so launch and run failures stay outside the repairable set.
  const attempts = [];
  const provider = new FakeProvider();
  provider.draftTimeline = async (request) => {
    attempts.push(request);
    throw new AppError('PROVIDER_LAUNCH_FAILED', 'Unable to start cursor-agent', { status: 502 });
  };
  const fixture = setup(provider);
  try {
    await assert.rejects(
      () => fixture.execution.draftTimeline(fixture.project.id, 'Ship it', context('draft-launch')),
      (error) => {
        assert.equal(error.code, 'PROVIDER_LAUNCH_FAILED');
        return true;
      }
    );
    assert.equal(attempts.length, 1);
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('a draft that violates the contract twice is not retried again', async () => {
  const attempts = [];
  const provider = new FakeProvider();
  provider.draftTimeline = async (request) => {
    attempts.push(request);
    return {
      nodes: [{ id: 'm1', key: 'A', kind: 'milestone', title: 'Build', ordinal: 0 }],
      edges: [{ fromNodeId: 'm1', toNodeId: 'gate-1', type: 'code_gate' }],
      gates: []
    };
  };
  const fixture = setup(provider);
  try {
    await assert.rejects(
      () => fixture.execution.draftTimeline(fixture.project.id, 'Ship it', context('draft-retry-fail')),
      (error) => error.code === 'DANGLING_EDGE'
    );
    assert.equal(attempts.length, 2);
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('drafting passes a per-draft model override to the provider', async () => {
  const provider = new FakeProvider();
  const fixture = setup(provider);
  try {
    await fixture.execution.draftTimeline(
      fixture.project.id,
      'Add a login page',
      context('draft-with-model'),
      'opencode/big-pickle'
    );

    assert.equal(provider.draftRequests[0].model, 'opencode/big-pickle');
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('start passes the project model to the provider on execution', async () => {
  const provider = new FakeProvider();
  const fixture = setup(provider);
  try {
    fixture.projects.updateProvider(
      fixture.project.id,
      { providerConfig: { model: 'opencode/big-pickle' } },
      context('set-model')
    );
    await fixture.execution.schedule(fixture.project.id, context('schedule-with-model'));

    assert.equal(provider.requests[0].model, 'opencode/big-pickle');
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('unconfigured providers are refused with PROVIDER_UNAVAILABLE', async () => {
  const fixture = setup(new FakeProvider());
  try {
    fixture.projects.updateProvider(fixture.project.id, { providerKind: 'unknown' }, context('set-unknown'));
    await assert.rejects(
      () => fixture.execution.start(fixture.project.id, 'ready-step', context('unknown-provider')),
      (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.status === 503
    );
    assert.equal(fixture.provider.requests.length, 0);
  } finally {
    fixture.close();
    fixture.gitFixture.close();
  }
});

test('run completion events are attributed to the configured provider', async () => {
  const provider = new FakeProvider();
  const gitFixture = createGitFixture();
  const database = createTestDatabase();
  const events = new EventStore(database.db);
  const projects = new ProjectService(database.db, events);
  const timeline = new TimelineService(database.db, events);
  const project = projects.create(
    {
      name: 'OpenCode fixture',
      repoPath: gitFixture.repoPath,
      baseBranch: 'main',
      protectedBranches: ['main'],
      interactionLevel: 'automatic'
    },
    context('create-opencode')
  );
  projects.updateProvider(project.id, { providerKind: 'opencode' }, context('set-opencode'));
  timeline.replaceDraft(project.id, timelineGraph(), context('create-timeline-opencode'));
  const execution = new ExecutionService({
    db: database.db,
    eventStore: events,
    projectService: projects,
    timelineService: timeline,
    gitAdapter: new GitAdapter(),
    providers: new Map([['opencode', provider]]),
    worktreeDir: gitFixture.worktreeParent,
    outputLimitBytes: 50_000
  });

  try {
    await execution.schedule(project.id, context('schedule-opencode'));
    const runId = execution.list(project.id)[0].id;
    for (let attempt = 0; attempt < 50 && execution.get(runId).status !== 'review'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finish = events
      .readAfter(project.id, 0, 50)
      .find((event) => event.type === 'agent.run.review');
    assert.ok(finish, 'expected a completed run event');
    assert.equal(finish.actor.id, 'opencode');
  } finally {
    database.close();
    gitFixture.close();
  }
});
