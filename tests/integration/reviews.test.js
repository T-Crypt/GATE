import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EventStore } from '../../server/application/event-store.js';
import { ProjectService } from '../../server/application/project-service.js';
import { ReviewService } from '../../server/application/review-service.js';
import { TimelineService } from '../../server/application/timeline-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { createGitFixture } from '../helpers/git.js';

function context(key) {
  return {
    actor: { type: 'human', id: 'reviewer' },
    correlationId: key,
    idempotencyKey: key
  };
}

function setup() {
  const database = createTestDatabase();
  const git = createGitFixture();
  const events = new EventStore(database.db);
  const projects = new ProjectService(database.db, events);
  const timeline = new TimelineService(database.db, events);
  const project = projects.create(
    { name: 'Review fixture', repoPath: git.repoPath, baseBranch: 'main' },
    context('project')
  );
  timeline.replaceDraft(project.id, {
    nodes: [
      { id: 'milestone-a', key: 'A', kind: 'milestone', title: 'Review' },
      { id: 'step-a', key: 'A-1', kind: 'step', parentId: 'milestone-a', title: 'Review me' }
    ],
    edges: [],
    gates: [{ id: 'gate-a', nodeId: 'step-a', type: 'approval', title: 'Human approval' }]
  }, context('timeline'));
  const reviews = new ReviewService(database.db, events);
  return { ...database, git, project, reviews, events };
}

test('stale evidence cannot satisfy an approval gate', () => {
  const fixture = setup();
  try {
    fixture.db.prepare(
      `INSERT INTO runs(id, project_id, node_id, provider_kind, branch, worktree_path,
        base_sha, head_sha, status) VALUES (?, ?, ?, 'claude', ?, ?, ?, ?, 'review')`
    ).run('run-a', fixture.project.id, 'step-a', 'work/a', fixture.git.repoPath, 'base', 'new-head');

    fixture.reviews.submitEvidence(fixture.project.id, 'gate-a', {
      kind: 'test', headSha: 'old-head', output: 'passed before the latest change'
    }, context('evidence'));

    assert.throws(
      () => fixture.reviews.decide(fixture.project.id, 'gate-a', {
        decision: 'approved', note: 'looks good'
      }, context('approval')),
      (error) => error.code === 'STALE_EVIDENCE'
    );
    const bundle = fixture.reviews.get(fixture.project.id);
    assert.equal(bundle.gates[0].evidenceState, 'stale');
    assert.equal(bundle.gates[0].canApprove, false);
  } finally {
    fixture.close();
    fixture.git.close();
  }
});

test('fresh evidence and a human decision pass the gate immutably', () => {
  const fixture = setup();
  try {
    fixture.db.prepare(
      `INSERT INTO runs(id, project_id, node_id, provider_kind, branch, worktree_path,
        base_sha, head_sha, status) VALUES (?, ?, ?, 'claude', ?, ?, ?, ?, 'review')`
    ).run('run-a', fixture.project.id, 'step-a', 'work/a', fixture.git.repoPath, 'base', 'head-a');
    fixture.reviews.submitEvidence(fixture.project.id, 'gate-a', {
      kind: 'test', headSha: 'head-a', command: 'npm test', exitCode: 0, output: '36 passed'
    }, context('evidence'));

    const approval = fixture.reviews.decide(fixture.project.id, 'gate-a', {
      decision: 'approved', note: 'human reviewed'
    }, context('approval'));

    assert.equal(approval.decision, 'approved');
    assert.equal(fixture.reviews.get(fixture.project.id).gates[0].status, 'passed');
    assert.deepEqual(
      fixture.events.readAfter(fixture.project.id, 0, 20).slice(-2).map((event) => event.type),
      ['gate.evidence.submitted', 'gate.approval.decided']
    );
  } finally {
    fixture.close();
    fixture.git.close();
  }
});

test('an agent actor cannot decide a human approval gate', () => {
  const fixture = setup();
  try {
    assert.throws(
      () => fixture.reviews.decide(fixture.project.id, 'gate-a', { decision: 'rejected' }, {
        actor: { type: 'mcp', id: 'agent' }, correlationId: 'agent', idempotencyKey: 'agent'
      }),
      (error) => error.code === 'HUMAN_REVIEW_REQUIRED'
    );
  } finally {
    fixture.close();
    fixture.git.close();
  }
});
