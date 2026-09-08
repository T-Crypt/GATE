import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildServices } from '../../server/composition.js';
import { createTestDatabase } from '../helpers/database.js';
import { FakeProvider } from '../helpers/fake-provider.js';

test('service composition shares one event-backed application core', () => {
  const database = createTestDatabase();
  try {
    const services = buildServices({
      db: database.db,
      config: { worktreeDir: '/tmp/gate-composition', outputLimitBytes: 20_000 },
      providers: new Map([['claude', new FakeProvider()]])
    });
    assert.equal(services.projects.events, services.events);
    assert.equal(services.timeline.events, services.events);
    assert.equal(services.execution.events, services.events);
    assert.equal(services.reviews.db, database.db);
  } finally {
    database.close();
  }
});
