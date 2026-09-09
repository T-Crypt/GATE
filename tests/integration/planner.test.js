import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { GitAdapter } from '../../server/adapters/git.js';
import { ContextCompiler } from '../../server/application/context-compiler.js';
import { EventStore } from '../../server/application/event-store.js';
import { ExecutionService } from '../../server/application/execution-service.js';
import { FeatureService } from '../../server/application/feature-service.js';
import { InstructionService } from '../../server/application/instruction-service.js';
import { MemoryService } from '../../server/application/memory-service.js';
import { PlannerService } from '../../server/application/planner-service.js';
import { ProjectService } from '../../server/application/project-service.js';
import { TimelineService } from '../../server/application/timeline-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { createGitFixture } from '../helpers/git.js';

function command(idempotencyKey) {
  return { actor: { type: 'human', id: 'planner-owner' }, correlationId: 'planner', idempotencyKey };
}

function setup() {
  const repository = createGitFixture();
  fs.mkdirSync(path.join(repository.repoPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repository.repoPath, 'src', 'provider.js'), 'export function cancelProvider() { return true; }\n');
  repository.run(['add', '.']);
  repository.run(['commit', '-m', 'add planner fixture']);
  const database = createTestDatabase();
  const events = new EventStore(database.db);
  const git = new GitAdapter();
  const projects = new ProjectService(database.db, events, git);
  const project = projects.create({ name: 'Planner fixture', repoPath: repository.repoPath }, command('project'));
  const timeline = new TimelineService(database.db, events);
  const provider = new FakeProvider();
  const execution = new ExecutionService({ db: database.db, eventStore: events, projectService: projects, timelineService: timeline, gitAdapter: git, providers: new Map([['claude', provider]]), worktreeDir: path.join(repository.root, 'worktrees') });
  const instructions = new InstructionService({ db: database.db, projects, eventStore: events });
  const memory = new MemoryService({ db: database.db, projects, gitAdapter: git, eventStore: events });
  const contexts = new ContextCompiler({ db: database.db, projects, memory, instructions, gitAdapter: git, eventStore: events });
  const features = new FeatureService(database.db, events, projects);
  const planner = new PlannerService({ db: database.db, events, projects, features, memory, contexts, execution, timeline });
  return { ...database, repository, events, project, provider, timeline, memory, features, planner, closeAll() { database.close(); repository.close(); } };
}

test('feature planning persists grounded impact and remains proposed until acceptance', async () => {
  const fixture = setup();
  try {
    const feature = fixture.features.create(fixture.project.id, { title: 'Cancellation', intent: 'Change cancelProvider behavior safely.' }, command('feature'));
    await fixture.memory.refresh(fixture.project.id, { force: true }, command('refresh'));
    const request = await fixture.planner.plan(fixture.project.id, { sourceType: 'feature', sourceId: feature.id }, command('plan'));

    assert.equal(request.status, 'proposed');
    assert.equal(fixture.timeline.get(fixture.project.id).nodes.length, 0);
    assert.equal(fixture.features.get(fixture.project.id, feature.id).status, 'planning');
    assert.ok(request.impact.directMatches.some((node) => node.name === 'cancelProvider'));
    assert.equal(request.provenance.memoryRevisionSha, request.context.memoryRevisionSha);
    assert.match(fixture.provider.draftRequests[0].repositoryContext, /cancelProvider/);

    const accepted = fixture.planner.accept(fixture.project.id, request.id, command('accept'));
    assert.equal(accepted.status, 'accepted');
    assert.equal(fixture.features.get(fixture.project.id, feature.id).status, 'approved');
    assert.equal(accepted.nodes.length, 2);
    assert.equal(fixture.timeline.get(fixture.project.id).nodes.length, 2);
  } finally { fixture.closeAll(); }
});

test('planning rejects stale Memory before calling the provider', async () => {
  const fixture = setup();
  try {
    const feature = fixture.features.create(fixture.project.id, { title: 'Stale', intent: 'Plan against current code.' }, command('feature-stale'));
    await assert.rejects(
      fixture.planner.plan(fixture.project.id, { sourceType: 'feature', sourceId: feature.id }, command('plan-stale')),
      (error) => error.code === 'MEMORY_STALE'
    );
    assert.equal(fixture.provider.draftRequests.length, 0);
  } finally { fixture.closeAll(); }
});

test('issue planning and milestone expansion use the same proposed-plan boundary', async () => {
  const fixture = setup();
  try {
    await fixture.memory.refresh(fixture.project.id, { force: true }, command('refresh-shared'));
    const issueId = Number(fixture.db.prepare("INSERT INTO issues(project_id, title) VALUES (?, 'Fix cancelProvider regression')").run(fixture.project.id).lastInsertRowid);
    const issuePlan = await fixture.planner.plan(fixture.project.id, { sourceType: 'issue', sourceId: String(issueId) }, command('plan-issue'));
    assert.equal(issuePlan.sourceType, 'issue');
    const accepted = fixture.planner.accept(fixture.project.id, issuePlan.id, command('accept-issue'));
    const milestone = accepted.nodes.find((node) => node.kind === 'milestone');

    const expansion = await fixture.planner.expandMilestone(fixture.project.id, milestone.id, {}, command('expand'));
    assert.equal(expansion.status, 'proposed');
    assert.equal(expansion.sourceType, 'milestone');
    assert.equal(fixture.timeline.get(fixture.project.id).nodes.length, 2);
    assert.ok(expansion.draft.graph.nodes.length > 2);
    assert.ok(expansion.draft.graph.nodes.filter((node) => node.kind === 'step' && node.id !== 'draft-s').every((node) => node.parentId === milestone.id));
  } finally { fixture.closeAll(); }
});
