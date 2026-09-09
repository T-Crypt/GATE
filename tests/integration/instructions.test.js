import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { EventStore } from '../../server/application/event-store.js';
import { InstructionService } from '../../server/application/instruction-service.js';
import { ProjectService } from '../../server/application/project-service.js';
import { createTestDatabase } from '../helpers/database.js';
import { createRepository } from '../helpers/project.js';

function context(idempotencyKey) {
  return {
    actor: { type: 'human', id: 'test-user' },
    correlationId: 'correlation-instructions',
    idempotencyKey
  };
}

test('instruction updates preserve user content and write a locked GATE contract', () => {
  const repository = createRepository();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events);
  const instructions = new InstructionService({ db, projects, eventStore: events });

  try {
    const project = projects.create({ name: 'Workbench', repoPath: repository.repoPath }, context('create'));
    fs.writeFileSync(path.join(repository.repoPath, 'AGENTS.md'), '# Existing project rules\n\nKeep this line.\n');

    const result = instructions.update(
      project.id,
      { fileName: 'AGENTS.md', userContent: '# Existing project rules\n\nKeep this line.\n\nPrefer unit tests.\n' },
      context('write-agents')
    );

    assert.equal(result.status, 'valid');
    assert.match(result.content, /<!-- GATE:USER:START -->/);
    assert.match(result.content, /Prefer unit tests\./);
    assert.match(result.content, /<!-- GATE:MANAGED:START -->/);
    assert.match(result.content, /never approve a gate/i);
    assert.equal(events.readAfter(project.id, 0, 20).at(-1).type, 'project.instructions.updated');
  } finally {
    close();
    repository.close();
  }
});

test('instruction reads expose managed block corruption without overwriting user files', () => {
  const repository = createRepository();
  const { db, close } = createTestDatabase();
  const events = new EventStore(db);
  const projects = new ProjectService(db, events);
  const instructions = new InstructionService({ db, projects, eventStore: events });

  try {
    const project = projects.create({ name: 'Workbench', repoPath: repository.repoPath }, context('create-corrupt'));
    const instructionPath = path.join(repository.repoPath, 'CLAUDE.md');
    fs.writeFileSync(instructionPath, '<!-- GATE:MANAGED:START -->\nexternally edited\n');

    const result = instructions.get(project.id, 'CLAUDE.md');

    assert.equal(result.status, 'corrupt');
    assert.equal(fs.readFileSync(instructionPath, 'utf8'), '<!-- GATE:MANAGED:START -->\nexternally edited\n');
  } finally {
    close();
    repository.close();
  }
});
