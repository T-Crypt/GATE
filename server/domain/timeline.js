import { AppError } from './errors.js';

const transitions = new Map([
  ['planned', new Set(['ready', 'blocked', 'cancelled'])],
  ['ready', new Set(['running', 'blocked', 'cancelled'])],
  ['running', new Set(['review', 'blocked', 'failed', 'cancelled'])],
  ['blocked', new Set(['ready', 'running', 'cancelled'])],
  ['review', new Set(['approved', 'rejected', 'blocked'])],
  ['rejected', new Set(['ready', 'cancelled'])],
  ['approved', new Set(['complete'])],
  ['failed', new Set(['ready', 'cancelled'])],
  ['complete', new Set()],
  ['cancelled', new Set(['ready'])]
]);

export function assertAcyclic(nodes, edges) {
  const known = new Set(nodes.map((node) => node.id));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!known.has(edge.fromNodeId) || !known.has(edge.toNodeId)) {
      throw new AppError('DANGLING_EDGE', 'Timeline edge references a missing node', {
        status: 422,
        details: { edge }
      });
    }
    outgoing.get(edge.fromNodeId).push(edge.toNodeId);
  }

  const visiting = new Set();
  const visited = new Set();
  const path = [];

  function visit(id) {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id];
      throw new AppError('TIMELINE_CYCLE', 'Timeline dependencies must not contain a cycle', {
        status: 422,
        details: { path: cycle }
      });
    }
    if (visited.has(id)) return;
    visiting.add(id);
    path.push(id);
    for (const target of outgoing.get(id)) visit(target);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const node of nodes) visit(node.id);
}

export function assertTransition(from, to) {
  if (!transitions.get(from)?.has(to)) {
    throw new AppError('INVALID_TRANSITION', `Cannot move timeline node from ${from} to ${to}`, {
      status: 409,
      details: { from, to }
    });
  }
}

export function deriveReadiness(node, dependencies = [], gates = []) {
  if (node.status !== 'planned' && node.status !== 'blocked') return node.status;
  const dependencyReady = dependencies.every((dependency) =>
    ['approved', 'complete'].includes(dependency.status)
  );
  if (!dependencyReady) return 'planned';
  const blockingGate = gates.some(
    (gate) => gate.blocking && !['passed', 'approved', 'waived'].includes(gate.status)
  );
  return blockingGate ? 'blocked' : 'ready';
}
