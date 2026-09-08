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

test('adding an issue with a kind tags it, and syncing git refreshes the project digest', async () => {
  const database = createTestDatabase();
  const git = createGitFixture();
  try {
    const events = new EventStore(database.db);
    const projects = new ProjectService(database.db, events);
    const project = projects.create({ name: 'Digest', repoPath: git.repoPath }, context('project'));
    const dashboard = new DashboardService(database.db, events, projects, new GitAdapter());

    const bug = dashboard.addIssue(project.id, { title: 'Crash on save', kind: 'bug' }, context('bug'));
    assert.deepEqual(bug.tags.map((tag) => tag.name), ['bug']);

    assert.equal(dashboard.getDigest(project.id), null);
    await dashboard.syncGit(project.id, context('sync'));
    const digest = dashboard.getDigest(project.id);
    assert.ok(digest);
    assert.deepEqual(JSON.parse(digest.file_tree_json), ['README.md']);
    assert.equal(JSON.parse(digest.milestones_json).length, 0);
  } finally {
    database.close();
    git.close();
  }
});
