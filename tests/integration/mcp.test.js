import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../../server/mcp/server.js';
import { buildServices } from '../../server/composition.js';
import { createTestDatabase } from '../helpers/database.js';
import { FakeProvider } from '../helpers/fake-provider.js';

async function setup() {
  const database = createTestDatabase();
  database.db
    .prepare(`INSERT INTO projects(name, repo_path, protected_branches_json) VALUES (?, ?, ?)`)
    .run('MCP fixture', '/tmp/mcp-fixture', '["main"]');
  const services = buildServices({
    db: database.db,
    config: { worktreeDir: '/tmp/gate-mcp-worktrees', outputLimitBytes: 20_000 },
    providers: new Map([['claude', new FakeProvider()]])
  });
  const server = createMcpServer(services);
  const client = new Client({ name: 'gate-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    ...database,
    client,
    server,
    async cleanup() {
      await client.close();
      await server.close();
      database.close();
    }
  };
}

test('MCP exposes compact timeline and review tools', async () => {
  const fixture = await setup();
  try {
    const listed = await fixture.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes('timeline_get'));
    assert.ok(names.includes('timeline_replace_draft'));
    assert.ok(names.includes('step_start'));
    assert.ok(names.includes('review_get'));
    assert.ok(names.includes('gate_submit_evidence'));
    assert.ok(names.includes('issue_create'));
    assert.ok(names.includes('issue_update'));
    assert.ok(names.includes('note_create'));
    assert.ok(names.includes('activity_feed'));
    assert.ok(names.includes('memory_status'));
    assert.ok(names.includes('memory_search'));
    assert.ok(names.includes('memory_neighbors'));
    assert.ok(names.includes('memory_impact'));
    assert.ok(names.includes('memory_refresh'));
    assert.equal(names.includes('gate_decide'), false);

    const result = await fixture.client.callTool({
      name: 'timeline_get',
      arguments: { projectId: 1 }
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.projectId, 1);
    assert.deepEqual(result.structuredContent.nodes, []);
  } finally {
    await fixture.cleanup();
  }
});

test('mutating MCP tools require idempotency keys', async () => {
  const fixture = await setup();
  try {
    const result = await fixture.client.callTool({
      name: 'timeline_replace_draft',
      arguments: { projectId: 1, graph: { nodes: [], edges: [], gates: [] } }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /idempotency/i);
  } finally {
    await fixture.cleanup();
  }
});

test('MCP timeline mutations enforce domain cycle policy', async () => {
  const fixture = await setup();
  try {
    const result = await fixture.client.callTool({
      name: 'timeline_replace_draft',
      arguments: {
        projectId: 1,
        idempotencyKey: 'cycle-test',
        graph: {
          nodes: [
            { id: 'a', key: 'A', kind: 'milestone', title: 'A' },
            { id: 'b', key: 'B', kind: 'milestone', title: 'B' }
          ],
          edges: [
            { fromNodeId: 'a', toNodeId: 'b' },
            { fromNodeId: 'b', toNodeId: 'a' }
          ],
          gates: []
        }
      }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /TIMELINE_CYCLE/);
  } finally {
    await fixture.cleanup();
  }
});

test('MCP creates a tagged bug report and reads it back through the activity feed', async () => {
  const fixture = await setup();
  try {
    const created = await fixture.client.callTool({
      name: 'issue_create',
      arguments: { projectId: 1, title: 'Crash on save', kind: 'bug', idempotencyKey: 'bug-1' }
    });
    assert.equal(created.isError, undefined);
    assert.equal(created.structuredContent.title, 'Crash on save');
    assert.deepEqual(created.structuredContent.tags.map((tag) => tag.name), ['bug']);

    const updated = await fixture.client.callTool({
      name: 'issue_update',
      arguments: { projectId: 1, issueId: created.structuredContent.id, status: 'closed', idempotencyKey: 'bug-1-close' }
    });
    assert.equal(updated.structuredContent.status, 'closed');

    const note = await fixture.client.callTool({
      name: 'note_create',
      arguments: { projectId: 1, body: 'Root cause documented', idempotencyKey: 'note-1' }
    });
    assert.equal(note.structuredContent.body, 'Root cause documented');

    const feed = await fixture.client.callTool({
      name: 'activity_feed',
      arguments: { projectId: 1 }
    });
    assert.equal(feed.isError, undefined);
    assert.deepEqual(feed.structuredContent.runs, []);
  } finally {
    await fixture.cleanup();
  }
});
