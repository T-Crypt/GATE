import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { GitAdapter } from '../../server/adapters/git.js';
import { ContextCompiler } from '../../server/application/context-compiler.js';
import { DashboardService } from '../../server/application/dashboard-service.js';
import { EventStore } from '../../server/application/event-store.js';
import { ExecutionService } from '../../server/application/execution-service.js';
import { FeatureService } from '../../server/application/feature-service.js';
import { InboxService } from '../../server/application/inbox-service.js';
import { InstructionService } from '../../server/application/instruction-service.js';
import { MemoryService } from '../../server/application/memory-service.js';
import { PlannerService } from '../../server/application/planner-service.js';
import { ProjectService } from '../../server/application/project-service.js';
import { TimelineService } from '../../server/application/timeline-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { createGitFixture } from '../helpers/git.js';

function command(idempotencyKey) {
  return { actor: { type: 'human', id: 'inbox-owner' }, correlationId: 'inbox', idempotencyKey };
}

function setup() {
  const repository = createGitFixture();
  fs.mkdirSync(path.join(repository.repoPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repository.repoPath, 'src', 'provider.js'), 'export function cancelProvider() { return true; }\n');
  repository.run(['add', '.']);
  repository.run(['commit', '-m', 'add inbox fixture']);
  const database = createTestDatabase();
  const events = new EventStore(database.db);
  const git = new GitAdapter();
  const projects = new ProjectService(database.db, events, git);
  const project = projects.create({ name: 'Inbox fixture', repoPath: repository.repoPath }, command('project'));
  const timeline = new TimelineService(database.db, events);
  const execution = new ExecutionService({ db: database.db, eventStore: events, projectService: projects, timelineService: timeline, gitAdapter: git, providers: new Map([['claude', new FakeProvider()]]), worktreeDir: path.join(repository.root, 'worktrees') });
  const instructions = new InstructionService({ db: database.db, projects, eventStore: events });
  const memory = new MemoryService({ db: database.db, projects, gitAdapter: git, eventStore: events });
  const contexts = new ContextCompiler({ db: database.db, projects, memory, instructions, gitAdapter: git, eventStore: events });
  const features = new FeatureService(database.db, events, projects);
  const planner = new PlannerService({ db: database.db, events, projects, features, memory, contexts, execution, timeline, gitAdapter: git });
  execution.attachPlanner(planner);
  const dashboard = new DashboardService(database.db, events, projects, git);
  const inbox = new InboxService({ db: database.db, events, projects, planner });
  return { ...database, repository, events, project, timeline, memory, execution, features, planner, dashboard, inbox, closeAll() { database.close(); repository.close(); } };
}

async function acceptedPlan(fixture, title = 'Cancellation') {
  const feature = fixture.features.create(fixture.project.id, { title, intent: 'Change cancelProvider behavior safely.' }, command(`feature-${title}`));
  await fixture.memory.refresh(fixture.project.id, { force: true }, command(`refresh-${title}`));
  const proposed = await fixture.planner.plan(fixture.project.id, { sourceType: 'feature', sourceId: feature.id }, command(`plan-${title}`));
  return { feature, plan: fixture.planner.accept(fixture.project.id, proposed.id, command(`accept-${title}`)) };
}

function commitFile(fixture, relativePath, contents, message) {
  const target = path.join(fixture.repository.repoPath, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  fixture.repository.run(['add', '.']);
  fixture.repository.run(['commit', '-m', message]);
}

function recordFailedRun(fixture, { id, branch, nodeId }) {
  fixture.db.prepare(
    `INSERT INTO runs(id, project_id, node_id, provider_kind, branch, worktree_path, base_sha, head_sha, status, finished_at)
     VALUES (?, ?, ?, 'claude', ?, '/tmp/worktree', 'base', 'head', 'failed', datetime('now'))`
  ).run(id, fixture.project.id, nodeId || null, branch);
}

test('a drifted accepted plan appears in the inbox and a current one does not', async () => {
  const fixture = setup();
  try {
    const { plan } = await acceptedPlan(fixture);
    assert.deepEqual((await fixture.inbox.list(fixture.project.id)).items.filter((item) => item.kind === 'plan_stale'), []);

    commitFile(fixture, 'src/provider.js', 'export function cancelProvider() { return false; }\n', 'change grounded file');
    const listed = await fixture.inbox.list(fixture.project.id);
    const item = listed.items.find((entry) => entry.kind === 'plan_stale');

    assert.ok(item, 'expected the drifted plan to surface');
    assert.equal(item.key, `plan_stale:${plan.id}`);
    assert.equal(item.planningRequestId, plan.id);
    assert.equal(item.staleness.status, 'STALE');
    assert.deepEqual(item.staleness.changedGroundingFiles, ['src/provider.js']);
    assert.deepEqual(item.actions, ['analyze', 'reground', 'convert', 'dismiss']);
    assert.equal(listed.counts.plan_stale, 1);
  } finally { fixture.closeAll(); }
});

test('dismissing an item removes it durably without touching the record it came from', async () => {
  const fixture = setup();
  try {
    const { plan } = await acceptedPlan(fixture);
    commitFile(fixture, 'src/provider.js', 'export function cancelProvider() { return false; }\n', 'change grounded file');
    const key = `plan_stale:${plan.id}`;

    const dismissed = fixture.inbox.dismiss(fixture.project.id, key, command('dismiss'));
    const repeated = fixture.inbox.dismiss(fixture.project.id, key, command('dismiss'));
    assert.equal(dismissed.itemKey, key);
    assert.deepEqual(repeated, dismissed);

    assert.equal((await fixture.inbox.list(fixture.project.id)).items.some((item) => item.key === key), false);
    // Survives a reload: the decision is a row, not page state.
    const reopened = new InboxService({ db: fixture.db, events: fixture.events, projects: fixture.planner.projects, planner: fixture.planner });
    assert.equal((await reopened.list(fixture.project.id)).items.some((item) => item.key === key), false);

    assert.equal(fixture.planner.get(fixture.project.id, plan.id).status, 'accepted');
    assert.equal(fixture.events.readAfter(fixture.project.id, 0, 200).some((event) => event.type === 'inbox.dismissed'), true);
  } finally { fixture.closeAll(); }
});

test('a failed run appears until an issue tracks its branch', async () => {
  const fixture = setup();
  try {
    recordFailedRun(fixture, { id: '33333333-3333-4333-8333-333333333333', branch: 'work/gate-33333333' });
    const listed = await fixture.inbox.list(fixture.project.id);
    const item = listed.items.find((entry) => entry.kind === 'run_failed');

    assert.ok(item, 'expected the failed run to surface');
    assert.equal(item.runId, '33333333-3333-4333-8333-333333333333');
    assert.equal(item.convert.branch, 'work/gate-33333333');
    assert.equal(item.convert.kind, 'bug');

    // Converting to an issue is the follow-up; the item clears because the
    // issue now tracks that branch, not because the inbox stored anything.
    const issue = fixture.dashboard.addIssue(fixture.project.id, item.convert, command('convert'));
    assert.equal(issue.branch, 'work/gate-33333333');
    assert.equal((await fixture.inbox.list(fixture.project.id)).items.some((entry) => entry.kind === 'run_failed'), false);
  } finally { fixture.closeAll(); }
});

test('a proposed plan waits in the inbox and a re-grounded proposal replaces the stale item', async () => {
  const fixture = setup();
  try {
    const feature = fixture.features.create(fixture.project.id, { title: 'Streaming', intent: 'Change cancelProvider streaming.' }, command('feature-proposed'));
    await fixture.memory.refresh(fixture.project.id, { force: true }, command('refresh-proposed'));
    const proposed = await fixture.planner.plan(fixture.project.id, { sourceType: 'feature', sourceId: feature.id }, command('plan-proposed'));

    const waiting = (await fixture.inbox.list(fixture.project.id)).items.find((item) => item.kind === 'plan_proposed');
    assert.equal(waiting.key, `plan_proposed:${proposed.id}`);
    assert.equal(waiting.route, 'features');
    assert.deepEqual(waiting.actions, ['analyze', 'dismiss']);

    fixture.planner.accept(fixture.project.id, proposed.id, command('accept-proposed'));
    assert.equal((await fixture.inbox.list(fixture.project.id)).items.some((item) => item.kind === 'plan_proposed'), false);

    commitFile(fixture, 'src/provider.js', 'export function cancelProvider() { return false; }\n', 'change grounded file');
    await fixture.memory.refresh(fixture.project.id, {}, command('refresh-after-drift'));
    assert.equal((await fixture.inbox.list(fixture.project.id)).items.some((item) => item.kind === 'plan_stale'), true);

    const regrounded = await fixture.planner.reground(fixture.project.id, proposed.id, {}, command('reground'));
    const afterReground = await fixture.inbox.list(fixture.project.id);
    // The decision moved to the new proposal; showing both would ask the human
    // to decide the same thing twice.
    assert.equal(afterReground.items.some((item) => item.kind === 'plan_stale'), false);
    assert.equal(afterReground.items.some((item) => item.key === `plan_proposed:${regrounded.id}`), true);
  } finally { fixture.closeAll(); }
});

test('an unknown item key is rejected rather than stored', async () => {
  const fixture = setup();
  try {
    assert.throws(
      () => fixture.inbox.dismiss(fixture.project.id, 'not a key', command('bad-key')),
      (error) => error.code === 'VALIDATION_FAILED'
    );
  } finally { fixture.closeAll(); }
});
