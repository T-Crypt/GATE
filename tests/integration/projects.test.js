import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { EventStore } from '../../server/application/event-store.js';
import { ProjectService } from '../../server/application/project-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { createRepository } from '../helpers/project.js';

function context(idempotencyKey = 'project-create-1') {
  return {
    actor: { type: 'human', id: 'test-user' },
    correlationId: 'correlation-projects',
    idempotencyKey
  };
}

test('create canonicalizes a Git project and always protects its base branch', () => {
  const repository = createRepository();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events);

  try {
    const project = projects.create(
      {
        name: ' Workbench ',
        repoPath: repository.repoPath,
        baseBranch: 'main',
        productionBranch: 'production',
        stableBranch: 'stable',
        protectedBranches: ['production']
      },
      context()
    );

    assert.equal(project.name, 'Workbench');
    assert.equal(project.repoPath, repository.repoPath);
    assert.deepEqual(project.protectedBranches, ['main', 'production', 'stable']);
    assert.equal(events.readAfter(project.id, 0, 20)[0].type, 'project.created');

    const gitignore = fs.readFileSync(path.join(repository.repoPath, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.gate\/$/m);
  } finally {
    close();
    repository.close();
  }
});

test('repeating an idempotent create returns the original result', () => {
  const repository = createRepository();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events);
  const input = { name: 'Workbench', repoPath: repository.repoPath, baseBranch: 'main' };

  try {
    const first = projects.create(input, context('same-key'));
    const second = projects.create(input, context('same-key'));

    assert.deepEqual(second, first);
    assert.equal(events.readAfter(first.id, 0, 20).length, 1);
  } finally {
    close();
    repository.close();
  }
});

test('reusing an idempotency key for another command is rejected', () => {
  const firstRepository = createRepository();
  const secondRepository = createRepository();
  const { db, close } = createTestDatabase();
  const projects = new ProjectService(db, new EventStore(db));

  try {
    projects.create({ name: 'First', repoPath: firstRepository.repoPath }, context('same-key'));
    assert.throws(
      () => projects.create({ name: 'Second', repoPath: secondRepository.repoPath }, context('same-key')),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    close();
    firstRepository.close();
    secondRepository.close();
  }
});

test('create rejects paths that are not Git repositories', () => {
  const { db, close } = createTestDatabase();
  const projects = new ProjectService(db, new EventStore(db));

  try {
    assert.throws(
      () => projects.create({ name: 'Invalid', repoPath: '/tmp' }, context()),
      (error) => error.code === 'INVALID_REPOSITORY'
    );
  } finally {
    close();
  }
});

test('policy updates cannot remove the base branch from protection', () => {
  const repository = createRepository();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events);

  try {
    const project = projects.create(
      { name: 'Workbench', repoPath: repository.repoPath, baseBranch: 'main' },
      context('create-for-policy')
    );
    const updated = projects.updatePolicy(
      project.id,
      {
        baseBranch: 'main',
        productionBranch: 'release',
        protectedBranches: ['release'],
        interactionLevel: 'automatic'
      },
      context('policy-update')
    );

    assert.deepEqual(updated.protectedBranches, ['main', 'release']);
    assert.equal(updated.interactionLevel, 'automatic');
    assert.equal(events.readAfter(project.id, 0, 20).at(-1).type, 'project.policy.updated');
  } finally {
    close();
    repository.close();
  }
});
