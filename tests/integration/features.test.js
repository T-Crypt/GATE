import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EventStore } from '../../server/application/event-store.js';
import { FeatureService } from '../../server/application/feature-service.js';
import { ProjectService } from '../../server/application/project-service.js';
import { createTestDatabase } from '../helpers/database.js';

function command(idempotencyKey) {
  return { actor: { type: 'human', id: 'owner' }, correlationId: 'features', idempotencyKey };
}

function setup() {
  const database = createTestDatabase();
  database.db.prepare("INSERT INTO projects(name, repo_path) VALUES ('Gate', 'E:/Github/GATE')").run();
  const events = new EventStore(database.db);
  return { ...database, events, features: new FeatureService(database.db, events, new ProjectService(database.db, events)) };
}

test('feature creation is idempotent and records its intent', () => {
  const fixture = setup();
  try {
    const input = { title: 'Codex provider', intent: 'Add a provider behind the existing contract.' };
    const first = fixture.features.create(1, input, command('create-feature'));
    const second = fixture.features.create(1, input, command('create-feature'));
    assert.deepEqual(second, first);
    assert.equal(first.status, 'idea');
    assert.equal(first.intent, input.intent);
    assert.deepEqual(fixture.features.list(1).map((feature) => feature.id), [first.id]);
    assert.deepEqual(fixture.events.readAfter(1).map((event) => event.type), ['feature.created']);
  } finally { fixture.close(); }
});

test('feature lifecycle rejects skipped and terminal transitions', () => {
  const fixture = setup();
  try {
    const feature = fixture.features.create(1, { title: 'Planner', intent: 'Ground plans in Memory.' }, command('create'));
    assert.throws(() => fixture.features.transition(1, feature.id, 'complete', command('skip')), (error) => error.code === 'INVALID_FEATURE_TRANSITION');
    assert.equal(fixture.features.transition(1, feature.id, 'planning', command('planning')).status, 'planning');
    assert.equal(fixture.features.transition(1, feature.id, 'cancelled', command('cancel')).status, 'cancelled');
    assert.throws(() => fixture.features.transition(1, feature.id, 'planning', command('revive')), (error) => error.code === 'INVALID_FEATURE_TRANSITION');
  } finally { fixture.close(); }
});

test('feature reads cannot cross project boundaries', () => {
  const fixture = setup();
  try {
    fixture.db.prepare("INSERT INTO projects(name, repo_path) VALUES ('Other', 'E:/Other')").run();
    const feature = fixture.features.create(1, { title: 'Scoped', intent: 'Stay in one project.' }, command('scoped'));
    assert.throws(() => fixture.features.get(2, feature.id), (error) => error.code === 'NOT_FOUND');
  } finally { fixture.close(); }
});
