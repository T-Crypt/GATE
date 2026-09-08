import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createRepository() {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'pmcp-project-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Project MCP Test'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@localhost'], { cwd: repoPath });

  return {
    repoPath,
    close() {
      rmSync(repoPath, { recursive: true, force: true });
    }
  };
}
