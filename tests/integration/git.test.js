import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitAdapter } from '../../server/adapters/git.js';
import { createGitFixture } from '../helpers/git.js';

test('createRunWorktree branches from main without changing main', async () => {
  const fixture = createGitFixture();
  const git = new GitAdapter();
  const mainBefore = fixture.run(['rev-parse', 'main']);

  try {
    const worktree = await git.createRunWorktree({
      repoPath: fixture.repoPath,
      baseBranch: 'main',
      protectedBranches: ['main', 'stable', 'production'],
      runId: 'run-7',
      parentDir: fixture.worktreeParent
    });

    assert.equal(worktree.branch, 'work/gate-run-7');
    assert.equal(worktree.baseSha, mainBefore);
    assert.equal(fixture.run(['rev-parse', 'main']), mainBefore);
    assert.equal((await git.inspect(worktree.path)).branch, 'work/gate-run-7');
  } finally {
    fixture.close();
  }
});

test('run preflight rejects an externally switched worktree branch', async () => {
  const fixture = createGitFixture();
  const git = new GitAdapter();

  try {
    const worktree = await git.createRunWorktree({
      repoPath: fixture.repoPath,
      baseBranch: 'main',
      protectedBranches: ['main'],
      runId: 'run-8',
      parentDir: fixture.worktreeParent
    });
    fixture.run(['switch', '-c', 'other-work'], worktree.path);

    await assert.rejects(
      () => git.assertRunWorkspace(worktree, ['main']),
      (error) => error.code === 'WORKTREE_BRANCH_MISMATCH'
    );
  } finally {
    fixture.close();
  }
});

test('worktree creation refuses a dirty base checkout', async () => {
  const fixture = createGitFixture();
  const git = new GitAdapter();
  fixture.write('README.md', '# changed\n');

  try {
    await assert.rejects(
      () =>
        git.createRunWorktree({
          repoPath: fixture.repoPath,
          baseBranch: 'main',
          protectedBranches: ['main'],
          runId: 'run-9',
          parentDir: fixture.worktreeParent
        }),
      (error) => error.code === 'DIRTY_BASE_WORKTREE'
    );
  } finally {
    fixture.close();
  }
});
