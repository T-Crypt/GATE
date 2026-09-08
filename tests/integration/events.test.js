import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EventStore } from '../../server/application/event-store.js';
import { createTestDatabase } from '../helpers/database.js';

test('append allocates monotonic per-project sequences', () => {
  const { db, close } = createTestDatabase();
  db.prepare(`INSERT INTO projects(name, repo_path) VALUES (?, ?)`).run('Sample', '/tmp/sample');
  const events = new EventStore(db);

  try {
    const base = {
      projectId: 1,
      actor: { type: 'human', id: 'test-user' },
      correlationId: 'correlation-1',
      payload: {}
    };
    const first = events.append({ ...base, type: 'project.created' });
    const second = events.append({ ...base, type: 'project.policy.updated' });

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.deepEqual(
      events.readAfter(1, 0, 20).map((event) => event.type),
      ['project.created', 'project.policy.updated']
    );
  } finally {
    close();
  }
});

test('append rolls back event and projection when projection fails', () => {
  const { db, close } = createTestDatabase();
  db.prepare(`INSERT INTO projects(name, repo_path) VALUES (?, ?)`).run('Sample', '/tmp/sample');
  const events = new EventStore(db);

  try {
    assert.throws(
      () =>
        events.append(
          {
            projectId: 1,
            type: 'project.policy.updated',
            actor: { type: 'human', id: 'test-user' },
            correlationId: 'correlation-2',
            payload: { baseBranch: 'stable' }
          },
          () => {
            throw new Error('projection failed');
          }
        ),
      /projection failed/
    );
    assert.equal(events.readAfter(1, 0, 20).length, 0);
    assert.equal(db.prepare('SELECT last_sequence FROM projects WHERE id = 1').get().last_sequence, 0);
  } finally {
    close();
  }
});
