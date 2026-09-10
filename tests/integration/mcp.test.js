import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../../server/mcp/server.js';
import { buildServices } from '../../server/composition.js';
import { createTestDatabase } from '../helpers/database.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { createGitFixture } from '../helpers/git.js';

async function setup(repoPath = '/tmp/mcp-fixture') {
  const database = createTestDatabase();
  database.db
    .prepare(`INSERT INTO projects(name, repo_path, protected_branches_json) VALUES (?, ?, ?)`)
    .run('MCP fixture', repoPath, '["main"]');
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
    services,
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
    assert.ok(names.includes('memory_explain'));
    assert.ok(names.includes('memory_god_nodes'));
    assert.ok(names.includes('memory_communities'));
    assert.ok(names.includes('memory_path'));
    assert.ok(names.includes('memory_query'));
    assert.ok(names.includes('memory_refresh'));
    assert.ok(names.includes('memory_context'));
    assert.ok(names.includes('feature_create'));
    assert.ok(names.includes('feature_plan'));
    assert.ok(names.includes('issue_plan'));
    assert.ok(names.includes('milestone_expand'));
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

test('MCP creates and reads durable features without approval capability', async () => {
  const fixture = await setup();
  try {
    const created = await fixture.client.callTool({ name: 'feature_create', arguments: { projectId: 1, title: 'Feature workspace', intent: 'Add durable feature planning.', idempotencyKey: 'mcp-feature' } });
    assert.equal(created.isError, undefined);
    assert.equal(created.structuredContent.status, 'idea');
    const listed = await fixture.client.callTool({ name: 'feature_list', arguments: { projectId: 1 } });
    assert.deepEqual(listed.structuredContent.items.map((feature) => feature.id), [created.structuredContent.id]);
    const tools = await fixture.client.listTools();
    assert.equal(tools.tools.some((tool) => /approve|merge|push/.test(tool.name)), false);
  } finally { await fixture.cleanup(); }
});

test('MCP memory impact returns symbol-grounded structural dependents', async () => {
  const repository = createGitFixture();
  fs.mkdirSync(path.join(repository.repoPath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repository.repoPath, 'src', 'core.js'),
    'export function stream() {}\n// Normalizes provider output into ordered chunks.\n'
  );
  fs.writeFileSync(
    path.join(repository.repoPath, 'src', 'adapter.js'),
    "import { stream } from './core.js';\nexport function adapt() { return stream(); }\n"
  );
  repository.run(['add', '.']);
  repository.run(['commit', '-m', 'add MCP memory fixture']);
  const fixture = await setup(repository.repoPath);
  try {
    const refreshed = await fixture.client.callTool({
      name: 'memory_refresh',
      arguments: { projectId: 1, force: true, idempotencyKey: 'mcp-memory-refresh' }
    });
    assert.equal(refreshed.isError, undefined);

    const impact = await fixture.client.callTool({
      name: 'memory_impact',
      arguments: { projectId: 1, query: 'stream' }
    });
    assert.equal(impact.isError, undefined);
    assert.deepEqual(impact.structuredContent.symbols.map((item) => item.name), ['stream']);
    assert.deepEqual(impact.structuredContent.dependents.map((item) => item.path), ['src/adapter.js']);

    const search = await fixture.client.callTool({
      name: 'memory_search',
      arguments: { projectId: 1, query: 'normalizes ordered chunks' }
    });
    assert.equal(search.structuredContent.items[0].matchStrategy, 'semantic');
    const symbolId = impact.structuredContent.symbols[0].id;
    const neighborhood = await fixture.client.callTool({
      name: 'memory_neighbors',
      arguments: { projectId: 1, nodeId: symbolId, depth: 2, edgeTypes: ['REFERENCES'] }
    });
    assert.deepEqual(neighborhood.structuredContent.edgeTypes, ['REFERENCES']);
    assert.ok(neighborhood.structuredContent.edges.every((edge) => edge.type === 'REFERENCES'));

    const explained = await fixture.client.callTool({
      name: 'memory_explain',
      arguments: { projectId: 1, nodeId: symbolId, query: 'stream' }
    });
    assert.equal(explained.isError, undefined);
    assert.equal(explained.structuredContent.matched, true);
    assert.equal(explained.structuredContent.sourceLocation, 'src/core.js:1');
    assert.ok(explained.structuredContent.relationships.every((relation) => relation.edgeId));

    const central = await fixture.client.callTool({
      name: 'memory_god_nodes',
      arguments: { projectId: 1, edgeTypes: ['IMPORTS'] }
    });
    assert.equal(central.structuredContent.items[0].path, 'src/core.js');

    const grouped = await fixture.client.callTool({ name: 'memory_communities', arguments: { projectId: 1 } });
    assert.equal(grouped.structuredContent.count, 1);

    const coreFile = grouped.structuredContent.items[0].members.find((node) => node.path === 'src/core.js');
    const adapterFile = grouped.structuredContent.items[0].members.find((node) => node.path === 'src/adapter.js');
    const walked = await fixture.client.callTool({
      name: 'memory_path',
      arguments: { projectId: 1, fromNodeId: adapterFile.id, toNodeId: coreFile.id, edgeTypes: ['IMPORTS'] }
    });
    assert.equal(walked.structuredContent.hops, 1);

    const missing = await fixture.client.callTool({
      name: 'memory_path',
      arguments: { projectId: 1, fromNodeId: coreFile.id, toNodeId: 'memory:1:file:absent' }
    });
    assert.equal(missing.isError, true);

    const answered = await fixture.client.callTool({
      name: 'memory_query',
      arguments: { projectId: 1, question: 'what depends on stream?', budget: 2000 }
    });
    assert.equal(answered.isError, undefined);
    assert.ok(answered.structuredContent.citations.every((item) => item.sourceLocation));
    assert.match(answered.structuredContent.answer, /stream/);

    const context = await fixture.client.callTool({
      name: 'memory_context',
      arguments: {
        projectId: 1,
        goal: 'Change provider stream normalization',
        kind: 'execution',
        tokenBudget: 1200,
        idempotencyKey: 'mcp-memory-context'
      }
    });
    assert.equal(context.isError, undefined);
    assert.equal(context.structuredContent.kind, 'execution');
    assert.ok(context.structuredContent.provenance.sourceFiles.includes('src/core.js'));
  } finally {
    await fixture.cleanup();
    repository.close();
  }
});
