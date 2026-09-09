import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { assertMutableBranch, assertProtectedPolicy } from '../domain/branch-policy.js';
import { AppError } from '../domain/errors.js';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000
    });
    return stdout.trim();
  } catch (error) {
    throw new AppError('GIT_COMMAND_FAILED', `Git ${args[0]} failed`, {
      status: 409,
      details: {
        command: ['git', ...args],
        stderr: String(error.stderr || error.message).trim().slice(0, 2000)
      }
    });
  }
}

// Must match the block ensureGateIgnored() appends in repo-mirror.js exactly.
const GATE_IGNORE_BLOCK = '# Gate local project state (not shared by default)\n.gate/\n';

async function committedGitignore(root) {
  try {
    const { stdout } = await execFileAsync('git', ['show', 'HEAD:.gitignore'], {
      cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30_000
    });
    return stdout;
  } catch {
    return null;
  }
}

// True only when a working-tree .gitignore differs from its committed version by
// exactly Gate's own appended block and nothing else — a genuine hand-edit to any
// other line still counts as real uncommitted work.
async function isOnlyGateIgnoreChange(root) {
  const committed = await committedGitignore(root);
  let working;
  try {
    working = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return false;
  }
  if (committed === null) return working === GATE_IGNORE_BLOCK;
  if (!working.startsWith(committed)) return false;
  return working.slice(committed.length) === GATE_IGNORE_BLOCK
    || working.slice(committed.length) === `\n${GATE_IGNORE_BLOCK}`;
}

function safeRunId(runId) {
  const normalized = String(runId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(normalized)) {
    throw new AppError('INVALID_RUN_ID', 'Run id may contain letters, numbers, and dashes', {
      status: 422
    });
  }
  return normalized.toLowerCase();
}

export class GitAdapter {
  async inspect(repoPath) {
    const root = fs.realpathSync(await git(repoPath, ['rev-parse', '--show-toplevel']));
    const headSha = await git(root, ['rev-parse', 'HEAD']);
    let branch = null;
    try {
      branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    } catch (error) {
      if (error.code !== 'GIT_COMMAND_FAILED') throw error;
    }
    const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
    // .gate/ is gate's own generated mirror (issues/timeline/notes snapshot), regenerated
    // from the database on every mutation. A .gitignore change is also exempt, but only
    // when it's exactly Gate's own appended ".gate/" entry and nothing else — a genuine
    // hand-edit to .gitignore still correctly counts as uncommitted work. Neither should
    // trip the "no uncommitted work" guard that keeps runs branching from a known-clean tree.
    const statusLines = status.split('\n').filter(Boolean);
    const onlyGateIgnoreChange = statusLines.some((line) => line.slice(3) === '.gitignore')
      && await isOnlyGateIgnoreChange(root);
    const relevantStatus = statusLines.filter((line) => {
      const filePath = line.slice(3).split(' -> ').pop();
      if (filePath.startsWith('.gate/')) return false;
      if (filePath === '.gitignore' && onlyGateIgnoreChange) return false;
      return true;
    });
    const gitDir = path.resolve(root, await git(root, ['rev-parse', '--git-dir']));
    const commonDir = path.resolve(root, await git(root, ['rev-parse', '--git-common-dir']));

    return {
      root,
      branch,
      headSha,
      dirty: relevantStatus.length > 0,
      gitDir,
      commonDir,
      isWorktree: gitDir !== commonDir
    };
  }

  async remoteOrigin(repoPath) {
    const root = fs.realpathSync(await git(repoPath, ['rev-parse', '--show-toplevel']));
    try {
      return await git(root, ['remote', 'get-url', 'origin']);
    } catch {
      return null;
    }
  }

  async defaultBranch(repoPath) {
    const root = fs.realpathSync(await git(repoPath, ['rev-parse', '--show-toplevel']));
    try {
      const symbolic = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      return symbolic.replace(/^origin\//, '');
    } catch {
      const head = await git(root, ['rev-parse', '--symbolic-full-name', 'HEAD']).catch(() => 'main');
      return head.replace(/^refs\/heads\//, '') || 'main';
    }
  }

  async branches(repoPath) {
    const root = fs.realpathSync(await git(repoPath, ['rev-parse', '--show-toplevel']));
    const refs = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
      .catch(() => '');
    return refs.split('\n').filter(Boolean);
  }

  async createRunWorktree({ repoPath, baseBranch, protectedBranches, runId, parentDir, branchPrefix = 'work/gate-' }) {
    assertProtectedPolicy(baseBranch, protectedBranches);
    const source = await this.inspect(repoPath);
    if (source.dirty) {
      throw new AppError('DIRTY_BASE_WORKTREE', 'The source checkout has uncommitted changes', {
        status: 409,
        details: { repoPath: source.root }
      });
    }

    await git(source.root, ['check-ref-format', '--branch', baseBranch]);
    const baseSha = await git(source.root, ['rev-parse', '--verify', `${baseBranch}^{commit}`]);
    const branch = `${branchPrefix}${safeRunId(runId)}`;
    await git(source.root, ['check-ref-format', '--branch', branch]);
    const parent = path.resolve(parentDir);
    fs.mkdirSync(parent, { recursive: true });
    const worktreePath = path.join(parent, safeRunId(runId));
    if (fs.existsSync(worktreePath)) {
      throw new AppError('WORKTREE_EXISTS', `Worktree path already exists: ${worktreePath}`, {
        status: 409
      });
    }

    await git(source.root, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseSha]);
    const baseAfter = await git(source.root, ['rev-parse', '--verify', `${baseBranch}^{commit}`]);
    if (baseAfter !== baseSha) {
      await git(source.root, ['worktree', 'remove', '--force', worktreePath]);
      throw new AppError('BASE_BRANCH_MOVED', `Branch ${baseBranch} moved during setup`, {
        status: 409
      });
    }

    const result = {
      repoPath: source.root,
      path: fs.realpathSync(worktreePath),
      branch,
      baseBranch,
      baseSha,
      headSha: baseSha
    };
    await this.assertRunWorkspace(result, protectedBranches);
    return result;
  }

  async assertRunWorkspace(worktree, protectedBranches) {
    const actual = await this.inspect(worktree.path);
    assertMutableBranch({
      actualBranch: actual.branch,
      assignedBranch: worktree.branch,
      protectedBranches
    });
    if (!actual.isWorktree) {
      throw new AppError('WORKTREE_REQUIRED', 'Agent execution requires a linked Git worktree', {
        status: 409
      });
    }
    return actual;
  }

  async changedFiles({ worktreePath, baseSha }) {
    const output = await git(worktreePath, ['diff', '--name-only', `${baseSha}...HEAD`]);
    return output ? output.split('\n').filter(Boolean) : [];
  }

  async fileTree(repoPath, { ref = 'HEAD', maxEntries = 500 } = {}) {
    let output;
    try {
      output = await git(repoPath, ['ls-tree', '-r', '--name-only', ref]);
    } catch (error) {
      if (error.code === 'GIT_COMMAND_FAILED') return [];
      throw error;
    }
    const paths = output ? output.split('\n').filter(Boolean) : [];
    return paths.slice(0, maxEntries);
  }

  async history(repoPath, branch, limit = 100) {
    const count = Math.max(1, Math.min(Number(limit) || 100, 500));
    const output = await git(repoPath, [
      'log', branch, `-${count}`, '--date=iso-strict',
      '--pretty=format:%H%x1f%an%x1f%s%x1f%aI%x1e'
    ]);
    return output.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
      const [hash, author, message, committedAt] = record.split('\x1f');
      return { hash, author, message, committedAt };
    });
  }

  async removeRunWorktree(worktree, { force = false } = {}) {
    const actual = await this.inspect(worktree.path);
    if (actual.dirty && !force) {
      throw new AppError('DIRTY_RUN_WORKTREE', 'Worktree has uncommitted changes', {
        status: 409,
        details: { path: worktree.path }
      });
    }
    await git(worktree.repoPath, [
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      worktree.path
    ]);
  }
}
