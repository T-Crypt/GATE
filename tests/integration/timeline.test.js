import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EventStore } from '../../server/application/event-store.js';
import { ProjectService } from '../../server/application/project-service.js';
import { TimelineService } from '../../server/application/timeline-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { createRepository } from '../helpers/project.js';

function context(idempotencyKey) {
  return {
    actor: { type: 'human', id: 'test-user' },
    correlationId: `correlation-${idempotencyKey}`,
    idempotencyKey
  };
}

function graph() {
  return {
    nodes: [
      { id: 'milestone-a', key: 'A', kind: 'milestone', title: 'Foundation', ordinal: 0 },
      {
        id: 'step-a-2',
        key: 'A-2',
        kind: 'step',
        parentId: 'milestone-a',
        title: 'Enforce branch gate',
        ordinal: 1
      },
      { id: 'milestone-b', key: 'B', kind: 'milestone', title: 'Interface', ordinal: 1 },
      {
        id: 'step-b-9',
        key: 'B-9',
        kind: 'step',
        parentId: 'milestone-b',
        title: 'Show review state',
        ordinal: 8
      }
    ],
    edges: [
      {
        id: 'edge-a2-b9',
        fromNodeId: 'step-a-2',
        toNodeId: 'step-b-9',
        type: 'approval_gate'
      }
    ],
    gates: [
      {
        id: 'gate-a-2',
        nodeId: 'step-a-2',
        type: 'approval',
        title: 'Human review',
        blocking: true
      }
    ]
  };
}

function setup() {
  const repository = createRepository();
  const database = createTestDatabase();
  const events = new EventStore(database.db);
  const projects = new ProjectService(database.db, events);
  const project = projects.create(
    { name: 'Workbench', repoPath: repository.repoPath },
    context('create-project')
  );
  return {
    ...database,
    repository,
    events,
    project,
    timeline: new TimelineService(database.db, events)
  };
}

test('replaceDraft persists a cross-milestone gate as explicit graph data', () => {
  const fixture = setup();
  try {
    const timeline = fixture.timeline.replaceDraft(
      fixture.project.id,
      graph(),
      context('replace-draft')
    );
    assert.equal(timeline.edges[0].fromNodeId, 'step-a-2');
    assert.equal(timeline.edges[0].toNodeId, 'step-b-9');
    assert.equal(timeline.gates[0].type, 'approval');
    assert.equal(fixture.events.readAfter(fixture.project.id, 0, 20).at(-1).type, 'timeline.replaced');
  } finally {
    fixture.close();
    fixture.repository.close();
  }
});

test('replaceDraft rejects dangling dependency edges', () => {
  const fixture = setup();
  const invalid = graph();
  invalid.edges[0].toNodeId = 'missing';
  try {
    assert.throws(
      () => fixture.timeline.replaceDraft(fixture.project.id, invalid, context('invalid-draft')),
      (error) => error.code === 'DANGLING_EDGE'
    );
  } finally {
    fixture.close();
    fixture.repository.close();
  }
});

test('replaceDraft preserves locked nodes from an accepted timeline', () => {
  const fixture = setup();
  try {
    fixture.timeline.replaceDraft(fixture.project.id, graph(), context('initial-draft'));
    fixture.timeline.setLocked(
      fixture.project.id,
      'step-a-2',
      true,
      context('lock-step')
    );
    const changed = graph();
    changed.nodes.find((node) => node.id === 'step-a-2').title = 'Unsafe replacement';

    assert.throws(
      () => fixture.timeline.replaceDraft(fixture.project.id, changed, context('changed-draft')),
      (error) => error.code === 'LOCKED_NODE_CONFLICT'
    );
    assert.equal(fixture.timeline.get(fixture.project.id).nodes.find((node) => node.id === 'step-a-2').title, 'Enforce branch gate');
  } finally {
    fixture.close();
    fixture.repository.close();
  }
});
