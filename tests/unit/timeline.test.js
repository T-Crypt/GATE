import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertAcyclic,
  assertTransition,
  deriveReadiness
} from '../../server/domain/timeline.js';

test('a dependency cycle is rejected with its path', () => {
  assert.throws(
    () =>
      assertAcyclic(
        [{ id: 'a' }, { id: 'b' }],
        [
          { fromNodeId: 'a', toNodeId: 'b' },
          { fromNodeId: 'b', toNodeId: 'a' }
        ]
      ),
    (error) =>
      error.code === 'TIMELINE_CYCLE' && error.details.path.join(' -> ') === 'a -> b -> a'
  );
});

test('a blocking visual gate keeps otherwise ready work blocked', () => {
  assert.equal(
    deriveReadiness(
      { status: 'planned' },
      [{ status: 'complete' }],
      [{ type: 'visual', status: 'pending', blocking: true }]
    ),
    'blocked'
  );
});

test('a planned step becomes ready after dependencies and gates pass', () => {
  assert.equal(
    deriveReadiness(
      { status: 'planned' },
      [{ status: 'complete' }, { status: 'approved' }],
      [{ type: 'test', status: 'passed', blocking: true }]
    ),
    'ready'
  );
});

test('an invalid lifecycle transition is rejected', () => {
  assert.throws(
    () => assertTransition('planned', 'complete'),
    (error) => error.code === 'INVALID_TRANSITION'
  );
});
