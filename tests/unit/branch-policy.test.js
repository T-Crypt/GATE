import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertMutableBranch } from '../../server/domain/branch-policy.js';

test('base, stable, and production branches are always immutable', () => {
  for (const branch of ['main', 'stable', 'production']) {
    assert.throws(
      () =>
        assertMutableBranch({
          actualBranch: branch,
          assignedBranch: 'work/pmcp-run-7',
          protectedBranches: ['main', 'stable', 'production']
        }),
      (error) => error.code === 'PROTECTED_BRANCH'
    );
  }
});

test('execution requires the exact branch assigned to its run', () => {
  assert.throws(
    () =>
      assertMutableBranch({
        actualBranch: 'other-work',
        assignedBranch: 'work/pmcp-run-7',
        protectedBranches: ['main']
      }),
    (error) => error.code === 'WORKTREE_BRANCH_MISMATCH'
  );
});
