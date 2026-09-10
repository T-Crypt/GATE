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
  assert.deepEqual(node.required, ['id', 'key', 'kind', 'title', 'description', 'parentId', 'ordinal']);
  assert.deepEqual(node.properties.kind.enum, ['milestone', 'step']);
  assert.deepEqual(timelineSchema.properties.edges.items.required, ['fromNodeId', 'toNodeId', 'type']);
  assert.deepEqual(timelineSchema.properties.gates.items.required, [
    'nodeId',
    'type',
    'title',
    'blocking',
    'requiredEvidence'
  ]);
  assert.ok(timelineSchema.properties.edges.items.properties.type.enum.includes('depends_on'));
  assert.ok(timelineSchema.properties.gates.items.properties.type.enum.includes('approval'));
});

// Codex forwards this schema as an OpenAI strict structured output, which errors
// on a schema whose `required` omits a declared property — so the draft never
// happens rather than failing validation. Walk the whole schema instead of
// pinning three lists, so a new property cannot be added without being required.
test('every object in the provider schema satisfies strict structured-output rules', () => {
  const objects = [];
  (function walk(schema) {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'object') objects.push(schema);
    if (schema.properties) Object.values(schema.properties).forEach(walk);
    if (schema.items) walk(schema.items);
  })(timelineSchema);

  assert.equal(objects.length, 4, 'root, node, edge, and gate objects');
  for (const schema of objects) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      Object.keys(schema.properties).sort(),
      `required must list every property of ${Object.keys(schema.properties).join(',')}`
    );
  }
});

// The price of requiring every field is that a provider may now send an explicit
// null for one Gate treats as optional. Normalization has to absorb all of them.
test('a draft that sends null for every optional field still normalizes', () => {
  const graph = normalizeTimelineGraph({
    nodes: [
      { id: 'm1', key: 'M1', kind: 'milestone', title: 'Foundation', description: null, parentId: null, ordinal: null },
      { id: 's1', key: 'M1.1', kind: 'step', title: 'Scaffold', description: null, parentId: 'm1', ordinal: null }
    ],
    edges: [{ fromNodeId: 'm1', toNodeId: 's1', type: 'depends_on' }],
    gates: [{ nodeId: 's1', type: 'test', title: 'Suite green', blocking: null, requiredEvidence: null }]
  });
  assert.equal(graph.nodes[0].description, '');
  assert.equal(graph.nodes[0].ordinal, 0);
  assert.equal(graph.nodes[1].ordinal, 1);
  assert.deepEqual(graph.gates[0].requiredEvidence, []);
  // `blocking: null` must not read as "non-blocking" — a gate defaults to blocking.
  assert.equal(graph.gates[0].blocking, true);
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
