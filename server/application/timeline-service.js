import { randomUUID } from 'node:crypto';

import { runIdempotent } from './idempotency.js';
import { GATE_TYPES } from '../domain/gates.js';
import { assertAcyclic, assertTransition } from '../domain/timeline.js';
import { AppError, notFound, validation } from '../domain/errors.js';

const EDGE_TYPES = new Set([
  'depends_on',
  'code_gate',
  'test_gate',
  'build_gate',
  'plan_gate',
  'visual_gate',
  'approval_gate'
]);
const ACTIVE_STATES = new Set(['running', 'review', 'approved']);

function decodeNode(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.display_key,
    kind: row.kind,
    parentId: row.parent_id,
    ordinal: row.ordinal,
    title: row.title,
    description: row.description,
    status: row.status,
    locked: Boolean(row.locked),
    progress: row.progress,
    metadata: JSON.parse(row.metadata_json)
  };
}

function decodeEdge(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    type: row.type
  };
}

function decodeGate(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    nodeId: row.node_id,
    type: row.type,
    title: row.title,
    status: row.status,
    blocking: Boolean(row.blocking),
    requiredEvidence: JSON.parse(row.required_evidence_json)
  };
}

function requiredText(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw validation(`${field} is required`, { field });
  return result;
}

export function normalizeTimelineGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw validation('Timeline requires nodes and edges arrays');
  }
  const ids = new Set();
  const keys = new Set();
  const nodes = graph.nodes.map((node, index) => {
    const id = requiredText(node.id || randomUUID(), `nodes[${index}].id`);
    const key = requiredText(node.key, `nodes[${index}].key`);
    if (ids.has(id) || keys.has(key)) {
      throw validation('Timeline node ids and keys must be unique', { id, key });
    }
    ids.add(id);
    keys.add(key);
    if (!['milestone', 'step'].includes(node.kind)) {
      throw validation('Timeline node kind must be milestone or step', { id });
    }
    return {
      id,
      key,
      kind: node.kind,
      parentId: node.parentId || null,
      ordinal: Number.isInteger(node.ordinal) ? node.ordinal : index,
      title: requiredText(node.title, `nodes[${index}].title`),
      description: String(node.description ?? ''),
      status: node.status || 'planned',
      locked: Boolean(node.locked),
      progress: Number.isInteger(node.progress) ? node.progress : 0,
      metadata: node.metadata || {}
    };
  });

  for (const node of nodes) {
    if (node.kind === 'step' && (!node.parentId || !ids.has(node.parentId))) {
      throw new AppError('INVALID_PARENT', `Step ${node.id} requires an existing milestone parent`, {
        status: 422
      });
    }
  }

  const edges = graph.edges.map((edge) => ({
    id: edge.id || randomUUID(),
    fromNodeId: requiredText(edge.fromNodeId, 'edge.fromNodeId'),
    toNodeId: requiredText(edge.toNodeId, 'edge.toNodeId'),
    type: edge.type || 'depends_on'
  }));
  for (const edge of edges) {
    if (!EDGE_TYPES.has(edge.type)) throw validation(`Unknown timeline edge type ${edge.type}`);
  }
  assertAcyclic(nodes, edges);

  const gates = (graph.gates || []).map((gate) => {
    if (!ids.has(gate.nodeId)) {
      throw new AppError('INVALID_GATE_NODE', `Gate references missing node ${gate.nodeId}`, {
        status: 422
      });
    }
    if (!GATE_TYPES.has(gate.type)) throw validation(`Unknown gate type ${gate.type}`);
    return {
      id: gate.id || randomUUID(),
      nodeId: gate.nodeId,
      type: gate.type,
      title: requiredText(gate.title, 'gate.title'),
      status: gate.status || 'pending',
      blocking: gate.blocking !== false,
      requiredEvidence: Array.isArray(gate.requiredEvidence) ? gate.requiredEvidence : []
    };
  });
  return { nodes, edges, gates };
}

export class TimelineService {
  constructor(db, eventStore) {
    this.db = db;
    this.events = eventStore;
  }

  get(projectId) {
    const nodes = this.db
      .prepare('SELECT * FROM timeline_nodes WHERE project_id = ? ORDER BY ordinal, id')
      .all(projectId)
      .map(decodeNode);
    const edges = this.db
      .prepare('SELECT * FROM timeline_edges WHERE project_id = ? ORDER BY id')
      .all(projectId)
      .map(decodeEdge);
    const gates = this.db
      .prepare('SELECT * FROM gates WHERE project_id = ? ORDER BY id')
      .all(projectId)
      .map(decodeGate);
    return { projectId, nodes, edges, gates };
  }

  replaceDraft(projectId, input, context) {
    const graph = normalizeTimelineGraph(input);
    return runIdempotent(
      this.db,
      context,
      { command: 'timeline.replaceDraft', projectId, graph },
      () => {
        const current = this.get(projectId);
        for (const existing of current.nodes.filter(
          (node) => node.locked || ACTIVE_STATES.has(node.status)
        )) {
          const replacement = graph.nodes.find((node) => node.id === existing.id);
          if (
            !replacement ||
            replacement.title !== existing.title ||
            replacement.parentId !== existing.parentId ||
            replacement.kind !== existing.kind
          ) {
            throw new AppError(
              existing.locked ? 'LOCKED_NODE_CONFLICT' : 'ACTIVE_NODE_CONFLICT',
              `Timeline redraw cannot change protected node ${existing.key}`,
              { status: 409, details: { nodeId: existing.id } }
            );
          }
          replacement.locked = existing.locked;
          replacement.status = existing.status;
          replacement.progress = existing.progress;
        }

        this.events.append(
          {
            projectId,
            type: 'timeline.replaced',
            actor: context.actor,
            correlationId: context.correlationId,
            payload: {
              nodeCount: graph.nodes.length,
              edgeCount: graph.edges.length,
              gateCount: graph.gates.length
            }
          },
          () => this.#writeGraph(projectId, graph)
        );
        return this.get(projectId);
      }
    );
  }

  setLocked(projectId, nodeId, locked, context) {
    return runIdempotent(
      this.db,
      context,
      { command: 'timeline.setLocked', projectId, nodeId, locked: Boolean(locked) },
      () => {
        const node = this.db
          .prepare('SELECT * FROM timeline_nodes WHERE id = ? AND project_id = ?')
          .get(nodeId, projectId);
        if (!node) throw notFound('Timeline node', nodeId);
        this.events.append(
          {
            projectId,
            type: locked ? 'timeline.node.locked' : 'timeline.node.unlocked',
            actor: context.actor,
            correlationId: context.correlationId,
            payload: { nodeId }
          },
          () => {
            this.db.prepare('UPDATE timeline_nodes SET locked = ?, updated_at = datetime(\'now\') WHERE id = ?').run(locked ? 1 : 0, nodeId);
          }
        );
        return decodeNode(this.db.prepare('SELECT * FROM timeline_nodes WHERE id = ?').get(nodeId));
      }
    );
  }

  transition(projectId, nodeId, to, context) {
    return runIdempotent(
      this.db,
      context,
      { command: 'timeline.transition', projectId, nodeId, to },
      () => {
        const row = this.db
          .prepare('SELECT * FROM timeline_nodes WHERE id = ? AND project_id = ?')
          .get(nodeId, projectId);
        if (!row) throw notFound('Timeline node', nodeId);
        assertTransition(row.status, to);
        this.events.append(
          {
            projectId,
            type: 'timeline.node.transitioned',
            actor: context.actor,
            correlationId: context.correlationId,
            payload: { nodeId, from: row.status, to }
          },
          () => {
            const progress = to === 'complete' ? 100 : row.progress;
            this.db
              .prepare("UPDATE timeline_nodes SET status = ?, progress = ?, updated_at = datetime('now') WHERE id = ?")
              .run(to, progress, nodeId);
          }
        );
        return decodeNode(this.db.prepare('SELECT * FROM timeline_nodes WHERE id = ?').get(nodeId));
      }
    );
  }

  #writeGraph(projectId, graph) {
    this.db.prepare('DELETE FROM timeline_edges WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM gates WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM timeline_nodes WHERE project_id = ?').run(projectId);

    const insertNode = this.db.prepare(
      `INSERT INTO timeline_nodes(
         id, project_id, kind, parent_id, ordinal, title, description,
         status, locked, progress, display_key, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const orderedNodes = [...graph.nodes].sort((left, right) => {
      if (left.kind === right.kind) return left.ordinal - right.ordinal;
      return left.kind === 'milestone' ? -1 : 1;
    });
    for (const node of orderedNodes) {
      insertNode.run(
        node.id,
        projectId,
        node.kind,
        node.parentId,
        node.ordinal,
        node.title,
        node.description,
        node.status,
        node.locked ? 1 : 0,
        node.progress,
        node.key,
        JSON.stringify(node.metadata)
      );
    }

    const insertEdge = this.db.prepare(
      `INSERT INTO timeline_edges(id, project_id, from_node_id, to_node_id, type)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const edge of graph.edges) {
      insertEdge.run(edge.id, projectId, edge.fromNodeId, edge.toNodeId, edge.type);
    }

    const insertGate = this.db.prepare(
      `INSERT INTO gates(
         id, project_id, node_id, type, title, status, blocking, required_evidence_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const gate of graph.gates) {
      insertGate.run(
        gate.id,
        projectId,
        gate.nodeId,
        gate.type,
        gate.title,
        gate.status,
        gate.blocking ? 1 : 0,
        JSON.stringify(gate.requiredEvidence)
      );
    }
  }
}
