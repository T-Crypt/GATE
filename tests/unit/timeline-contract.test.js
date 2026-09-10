import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTimelinePrompt,
  timelineContractPrompt,
  timelineSchema
} from '../../server/adapters/providers/timeline-contract.js';
import { normalizeTimelineGraph } from '../../server/application/timeline-service.js';

// A draft that only satisfies the schema Gate hands the provider must also
// survive normalization; a looser schema lets providers invent field names and
// every draft is rejected after the model round-trip.
function schemaShapedDraft() {
  return {
    nodes: [
      { id: 'm1', key: 'M1', kind: 'milestone', title: 'Foundation', description: '', parentId: null, ordinal: 0 },
      { id: 's1', key: 'M1.1', kind: 'step', title: 'Scaffold', description: '', parentId: 'm1', ordinal: 1 },
      { id: 's2', key: 'M1.2', kind: 'step', title: 'Test', description: '', parentId: 'm1', ordinal: 2 }
    ],
    edges: [{ fromNodeId: 's1', toNodeId: 's2', type: 'depends_on' }],
    gates: [{ nodeId: 's2', type: 'test', title: 'Suite green', blocking: true, requiredEvidence: ['npm test'] }]
  };
}

test('the provider schema requires every field normalization demands', () => {
  const node = timelineSchema.properties.nodes.items;
  assert.deepEqual(node.required, ['id', 'key', 'kind', 'title']);
  assert.deepEqual(node.properties.kind.enum, ['milestone', 'step']);
  assert.deepEqual(timelineSchema.properties.edges.items.required, ['fromNodeId', 'toNodeId', 'type']);
  assert.deepEqual(timelineSchema.properties.gates.items.required, ['nodeId', 'type', 'title']);
  assert.ok(timelineSchema.properties.edges.items.properties.type.enum.includes('depends_on'));
  assert.ok(timelineSchema.properties.gates.items.properties.type.enum.includes('approval'));
});

test('a schema-shaped draft normalizes without error', () => {
  const graph = normalizeTimelineGraph(schemaShapedDraft());
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.gates.length, 1);
  assert.equal(graph.nodes[1].parentId, 'm1');
});

test('the prose contract names the same fields for providers without schema support', () => {
  for (const field of ['fromNodeId', 'toNodeId', 'parentId', 'nodeId', 'milestone', 'step']) {
    assert.ok(timelineContractPrompt.includes(field), `contract omits ${field}`);
  }
  const prompt = buildTimelinePrompt({ goal: 'Add a provider', repositoryContext: 'ctx' });
  assert.ok(prompt.includes('Goal: Add a provider'));
  assert.ok(prompt.includes('Repository context: ctx'));
  assert.ok(prompt.includes(timelineContractPrompt));
});

test('the contract tells providers that gates are not edge endpoints', () => {
  // A real draft failed with DANGLING_EDGE after pointing a code_gate edge at a
  // gate id; the *_gate edge names invite exactly that confusion.
  assert.match(timelineContractPrompt, /a gate is not a node/i);
  assert.match(timelineContractPrompt, /never be given an id of their own/i);
  assert.match(timelineContractPrompt, /they do not point at a gate/i);
});

test('feedback from a rejected attempt is appended to the retry prompt', () => {
  const plain = buildTimelinePrompt({ goal: 'g', repositoryContext: 'c' });
  assert.ok(!plain.includes('previous attempt'));
  const retry = buildTimelinePrompt({
    goal: 'g',
    repositoryContext: 'c',
    feedback: 'Timeline edge references a missing node'
  });
  assert.ok(retry.includes('A previous attempt was rejected: Timeline edge references a missing node'));
  assert.ok(retry.includes(timelineContractPrompt));
});
