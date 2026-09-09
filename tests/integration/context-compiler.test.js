import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { GitAdapter } from '../../server/adapters/git.js';
import { ContextCompiler } from '../../server/application/context-compiler.js';
import { EventStore } from '../../server/application/event-store.js';
import { InstructionService } from '../../server/application/instruction-service.js';
import { MemoryService } from '../../server/application/memory-service.js';
import { ProjectService } from '../../server/application/project-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { createGitFixture } from '../helpers/git.js';

function context(idempotencyKey) {
  return {
    actor: { type: 'human', id: 'context-test-user' },
    correlationId: `context-${idempotencyKey}`,
    idempotencyKey
  };
}

test('context compiler persists a token-budgeted capsule grounded in Memory and project rules', async () => {
  const repository = createGitFixture();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const git = new GitAdapter();
  const projects = new ProjectService(db, events, git);
  const instructions = new InstructionService({ db, projects, eventStore: events });
  const memory = new MemoryService({ db, projects, gitAdapter: git, eventStore: events });
  const compiler = new ContextCompiler({ db, projects, memory, instructions, gitAdapter: git, eventStore: events });

  try {
    fs.mkdirSync(path.join(repository.repoPath, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repository.repoPath, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(repository.repoPath, 'src', 'provider.js'),
      "export function cancelProvider() { return 'cancelled'; }\n// Provider cancellation stops a running harness safely.\n"
    );
    fs.writeFileSync(
      path.join(repository.repoPath, 'tests', 'provider.test.js'),
      "import { cancelProvider } from '../src/provider.js';\ntest('cancel', () => cancelProvider());\n"
    );
    const project = projects.create({ name: 'Context fixture', repoPath: repository.repoPath }, context('create'));
    instructions.update(project.id, {
      fileName: 'AGENTS.md',
      userContent: 'Provider adapters must retain the shared cancellation contract.'
    }, context('instructions'));
    repository.run(['add', '.']);
    repository.run(['commit', '-m', 'add context fixture']);
    await memory.refresh(project.id, { force: true }, context('refresh'));

    const capsule = await compiler.compile(project.id, {
      goal: 'Change provider cancellation behavior',
      kind: 'context',
      tokenBudget: 1200
    }, context('compile'));
    const repeated = await compiler.compile(project.id, {
      goal: 'Change provider cancellation behavior',
      kind: 'context',
      tokenBudget: 1200
    }, context('compile'));

    assert.equal(repeated.id, capsule.id);
    assert.equal(capsule.projectId, project.id);
    assert.equal(capsule.kind, 'context');
    assert.equal(capsule.repositorySha, repository.run(['rev-parse', 'HEAD']));
    assert.equal(capsule.memoryRevisionSha, capsule.repositorySha);
    assert.ok(capsule.estimatedTokens <= capsule.tokenBudget);
    assert.equal(capsule.payload.project.stage, 'active');
    assert.match(capsule.payload.projectRules[0].userContent, /shared cancellation contract/);
    assert.match(capsule.payload.projectRules[0].managedContent, /never approve a gate/);
    assert.ok(capsule.payload.files.some((file) => file.path === 'src/provider.js'));
    assert.ok(capsule.payload.tests.some((file) => file.path === 'tests/provider.test.js'));
    assert.ok(capsule.payload.symbols.some((symbol) => symbol.name === 'cancelProvider'));
    assert.ok(capsule.provenance.graphNodeIds.length > 0);
    assert.ok(capsule.provenance.sourceFiles.includes('src/provider.js'));
    assert.deepEqual(compiler.get(project.id, capsule.id), capsule);
    assert.equal(compiler.list(project.id, 10)[0].id, capsule.id);
    assert.equal(events.readAfter(project.id, 0, 20).at(-1).type, 'context.compiled');
  } finally {
    close();
    repository.close();
  }
});

test('context compiler refuses to use a stale memory revision', async () => {
  const repository = createGitFixture();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const git = new GitAdapter();
  const projects = new ProjectService(db, events, git);
  const instructions = new InstructionService({ db, projects, eventStore: events });
  const memory = new MemoryService({ db, projects, gitAdapter: git, eventStore: events });
  const compiler = new ContextCompiler({ db, projects, memory, instructions, gitAdapter: git, eventStore: events });

  try {
    const project = projects.create({ name: 'Stale fixture', repoPath: repository.repoPath }, context('create-stale'));
    await memory.refresh(project.id, { force: true }, context('refresh-stale'));
    fs.writeFileSync(path.join(repository.repoPath, 'changed.js'), 'export const changed = true;\n');
    repository.run(['add', '.']);
    repository.run(['commit', '-m', 'advance repository']);

    await assert.rejects(
      compiler.compile(project.id, { goal: 'Explain the change', tokenBudget: 1000 }, context('compile-stale')),
      (error) => error.code === 'MEMORY_STALE'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM context_capsules').get().count, 0);
  } finally {
    close();
    repository.close();
  }
});
