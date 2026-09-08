import { AppError } from './errors.js';

export function assertMutableBranch({ actualBranch, assignedBranch, protectedBranches }) {
  const protectedSet = new Set(protectedBranches || []);
  if (!actualBranch) {
    throw new AppError('DETACHED_HEAD', 'Execution is not allowed from a detached HEAD', {
      status: 409
    });
  }
  if (protectedSet.has(actualBranch)) {
    throw new AppError('PROTECTED_BRANCH', `Branch ${actualBranch} is protected`, {
      status: 409,
      details: { branch: actualBranch }
    });
  }
  if (actualBranch !== assignedBranch) {
    throw new AppError(
      'WORKTREE_BRANCH_MISMATCH',
      `Run requires ${assignedBranch}, but the worktree is on ${actualBranch}`,
      { status: 409, details: { actualBranch, assignedBranch } }
    );
  }
}

export function assertProtectedPolicy(baseBranch, protectedBranches) {
  if (!new Set(protectedBranches || []).has(baseBranch)) {
    throw new AppError('BASE_BRANCH_NOT_PROTECTED', 'The selected base branch must be protected', {
      status: 422,
      details: { baseBranch }
    });
  }
}
