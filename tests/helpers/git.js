import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createGitFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gate-git-'));
  const repoPath = path.join(root, 'repo');
  const worktreeParent = path.join(root, 'worktrees');
  execFileSync('git', ['init', '-b', 'main', repoPath], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Gate Test'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@localhost'], { cwd: repoPath });
  writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['branch', 'stable'], { cwd: repoPath });
  execFileSync('git', ['branch', 'production'], { cwd: repoPath });

  return {
    root,
    repoPath,
    worktreeParent,
    run(args, cwd = repoPath) {
      return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    },
    write(relativePath, content, cwd = repoPath) {
      writeFileSync(path.join(cwd, relativePath), content);
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
