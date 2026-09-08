import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DashboardService } from '../../server/application/dashboard-service.js';
import { EventStore } from '../../server/application/event-store.js';
import { ProjectService } from '../../server/application/project-service.js';
import { GitAdapter } from '../../server/adapters/git.js';
import { createTestDatabase } from '../helpers/database.js';
import { createGitFixture } from '../helpers/git.js';

const context = (key) => ({ actor: { type: 'human', id: 'dashboard' }, correlationId: key, idempotencyKey: key });

test('dashboard commands persist local issues, tagged notes, and observed commits', async () => {
  const database = createTestDatabase();
  const git = createGitFixture();
  try {
    const events = new EventStore(database.db);
    const projects = new ProjectService(database.db, events);
    const project = projects.create({ name: 'Dashboard', repoPath: git.repoPath }, context('project'));
    const dashboard = new DashboardService(database.db, events, projects, new GitAdapter());

    const issue = dashboard.addIssue(project.id, { title: 'Review safety' }, context('issue'));
    const note = dashboard.addNote(project.id, { body: 'Keep it local', tags: ['safety', 'local'] }, context('note'));
    const commits = await dashboard.syncGit(project.id, context('git'));

    assert.equal(issue.status, 'open');
    assert.deepEqual(note.tags.map((tag) => tag.name), ['local', 'safety']);
    assert.equal(commits.length, 1);
    assert.equal(dashboard.updateIssue(project.id, issue.id, { status: 'closed' }, context('close')).status, 'closed');
  } finally {
    database.close();
    git.close();
  }
});

test('dashboard summary reports git worktree status and changed files', async () => {
  const database = createTestDatabase();
  const git = createGitFixture();
  try {
    const events = new EventStore(database.db);
    const projects = new ProjectService(database.db, events);
    const project = projects.create({ name: 'Status', repoPath: git.repoPath }, context('project'));
    const dashboard = new DashboardService(database.db, events, projects, new GitAdapter());

    const clean = await dashboard.summary(project.id);
    assert.equal(clean.gitStatus.branch, 'main');
    assert.equal(clean.gitStatus.dirty, false);
    assert.deepEqual(clean.changedFiles, []);

    await dashboard.syncGit(project.id, context('sync'));
    git.write('README.md', '# fixture\nchanged\n');
    git.run(['add', 'README.md']);
    git.run(['commit', '-m', 'second']);

    const after = await dashboard.summary(project.id);
    assert.equal(after.gitStatus.dirty, false);
    assert.deepEqual(after.changedFiles, ['README.md']);
  } finally {
    database.close();
    git.close();
  }
});
