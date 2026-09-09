import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { EventStore } from '../../server/application/event-store.js';
import { FeatureService } from '../../server/application/feature-service.js';
import { ProjectService } from '../../server/application/project-service.js';
import { DashboardService } from '../../server/application/dashboard-service.js';
import { RepoMirrorService, ensureGateIgnored } from '../../server/application/repo-mirror.js';
import { GitAdapter } from '../../server/adapters/git.js';
import { createTestDatabase } from '../helpers/database.js';
import { createRepository } from '../helpers/project.js';

const context = (key) => ({ actor: { type: 'human', id: 'mirror-test' }, correlationId: key, idempotencyKey: key });

test('ensureGateIgnored adds .gate/ once and leaves other content alone', () => {
  const repository = createRepository();
  try {
    fs.writeFileSync(path.join(repository.repoPath, '.gitignore'), 'node_modules/\n');
    ensureGateIgnored(repository.repoPath);
    ensureGateIgnored(repository.repoPath);

    const content = fs.readFileSync(path.join(repository.repoPath, '.gitignore'), 'utf8');
    assert.match(content, /node_modules\//);
    assert.equal(content.match(/\.gate\//g)?.length, 1);
  } finally {
    repository.close();
  }
});

test('syncing the repo mirror keeps .gate/ gitignored for projects connected before this shipped', () => {
  const repository = createRepository();
  const database = createTestDatabase();
  try {
    const events = new EventStore(database.db);
    const projects = new ProjectService(database.db, events);
    const project = projects.create({ name: 'Mirror', repoPath: repository.repoPath }, context('project'));

    // Simulate a project connected before ensureGateIgnored existed at connect-time.
    fs.rmSync(path.join(repository.repoPath, '.gitignore'), { force: true });

    const mirror = new RepoMirrorService({ db: database.db, projects });
    const dashboard = new DashboardService(database.db, events, projects, new GitAdapter());
    dashboard.addIssue(project.id, { title: 'Track this' }, context('issue'));
    mirror.sync(project.id);

    const content = fs.readFileSync(path.join(repository.repoPath, '.gitignore'), 'utf8');
    assert.match(content, /\.gate\//);
    assert.ok(fs.existsSync(path.join(repository.repoPath, '.gate', 'issues.json')));
  } finally {
    database.close();
    repository.close();
  }
});

test('repo mirror exports durable features and planning links', () => {
  const repository = createRepository();
  const database = createTestDatabase();
  try {
    const events = new EventStore(database.db);
    const projects = new ProjectService(database.db, events);
    const project = projects.create({ name: 'Features', repoPath: repository.repoPath }, context('feature-project'));
    const features = new FeatureService(database.db, events, projects);
    const feature = features.create(project.id, { title: 'Context planning', intent: 'Keep planning grounded.' }, context('feature'));
    new RepoMirrorService({ db: database.db, projects }).sync(project.id);
    const exported = JSON.parse(fs.readFileSync(path.join(repository.repoPath, '.gate', 'features.json'), 'utf8'));
    assert.equal(exported[0].id, feature.id);
    assert.equal(exported[0].intent, 'Keep planning grounded.');
    assert.deepEqual(exported[0].planningRequests, []);
  } finally { database.close(); repository.close(); }
});
