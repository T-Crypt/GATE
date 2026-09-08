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
    config: { worktreeDir: '/tmp/pmcp-mcp-worktrees', outputLimitBytes: 20_000 },
    providers: new Map([['claude', new FakeProvider()]])
  });
  const server = createMcpServer(services);
  const client = new Client({ name: 'pmcp-test', version: '1.0.0' }, { capabilities: {} });
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
