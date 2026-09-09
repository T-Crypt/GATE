import { randomUUID } from 'node:crypto';

import { runIdempotent } from './idempotency.js';
import { normalizeTimelineGraph } from './timeline-service.js';
import { AppError, notFound, validation } from '../domain/errors.js';

function nested(context, suffix) {
  return { actor: context.actor, correlationId: context.correlationId, idempotencyKey: `${context.idempotencyKey}:${suffix}` };
}

function remapExpansion(current, milestone, raw) {
  const generated = normalizeTimelineGraph(raw);
  const steps = generated.nodes.filter((node) => node.kind === 'step');
  if (!steps.length) throw validation('Milestone expansion must contain at least one step');
  const currentIds = new Set(current.nodes.map((node) => node.id));
  const idMap = new Map(steps.map((step) => [step.id, randomUUID()]));
  const start = current.nodes.filter((node) => node.parentId === milestone.id).length + 1;
  const nodes = steps.map((step, index) => ({ ...step, id: idMap.get(step.id), key: `${milestone.key}-${start + index}`, parentId: milestone.id, ordinal: start + index - 1, status: 'planned', locked: false, progress: 0 }));
  const edges = generated.edges.filter((edge) => idMap.has(edge.fromNodeId) && idMap.has(edge.toNodeId)).map((edge) => ({ ...edge, id: randomUUID(), fromNodeId: idMap.get(edge.fromNodeId), toNodeId: idMap.get(edge.toNodeId) }));
  const gates = generated.gates.filter((gate) => idMap.has(gate.nodeId)).map((gate) => ({ ...gate, id: randomUUID(), nodeId: idMap.get(gate.nodeId), status: 'pending' }));
  if (nodes.some((node) => currentIds.has(node.id))) throw new AppError('EXPANSION_CONFLICT', 'Expansion attempted to replace an existing node', { status: 409 });
  return { nodes: [...current.nodes, ...nodes], edges: [...current.edges, ...edges], gates: [...current.gates, ...gates] };
}

export class PlannerService {
  constructor({ db, events, projects, features, memory, contexts, execution, timeline }) {
    Object.assign(this, { db, events, projects, features, memory, contexts, execution, timeline });
  }

  #source(projectId, sourceType, sourceId) {
    const id = String(sourceId ?? '').trim();
    if (!['feature', 'issue', 'milestone'].includes(sourceType) || !id) throw validation('A valid planning source is required');
    if (sourceType === 'feature') {
      const feature = this.features.get(projectId, id);
      return { id, goal: `${feature.title}\n\n${feature.intent}`, feature };
    }
    if (sourceType === 'issue') {
      const issue = this.db.prepare('SELECT * FROM issues WHERE project_id = ? AND id = ?').get(projectId, Number(id));
      if (!issue) throw notFound('Issue', id);
      return { id, goal: issue.title };
    }
    const milestone = this.timeline.get(projectId).nodes.find((node) => node.id === id && node.kind === 'milestone');
    if (!milestone) throw notFound('Milestone', id);
    return { id, goal: `${milestone.title}\n\n${milestone.description}`.trim(), milestone };
  }

  async plan(projectId, input, context, options = {}) {
    this.projects.get(projectId);
    const sourceType = String(input.sourceType || 'feature');
    const source = this.#source(projectId, sourceType, input.sourceId);
    const existing = this.db.prepare("SELECT id FROM planning_requests WHERE project_id = ? AND source_type = ? AND source_id = ? AND status = 'proposed'").get(projectId, sourceType, source.id);
    if (existing) throw new AppError('PLANNING_ALREADY_PROPOSED', 'This source already has a proposed plan', { status: 409, details: { planningRequestId: existing.id } });
    const impact = this.memory.impact(projectId, { query: source.goal, limit: 25 });
    const contextCapsule = await this.contexts.compile(projectId, { goal: source.goal, kind: 'planning', tokenBudget: input.tokenBudget || 4000 }, nested(context, 'context'));
    const currentIds = new Set((options.current?.nodes || []).map((node) => node.id));
    const draft = await this.execution.draftTimeline(projectId, source.goal, nested(context, 'draft'), input.model, {
      repositoryContext: JSON.stringify({ source: sourceType, context: contextCapsule.payload, provenance: contextCapsule.provenance }),
      transformGraph: options.transformGraph
    });
    const producedNodeIds = draft.graph.nodes.filter((node) => !currentIds.has(node.id)).map((node) => node.id);
    const provenance = { repositorySha: contextCapsule.repositorySha, memoryRevisionSha: contextCapsule.memoryRevisionSha, contextCapsuleId: contextCapsule.id, producedNodeIds };
    return runIdempotent(this.db, context, { command: 'planning.propose', projectId, sourceType, sourceId: source.id }, () => {
      const id = randomUUID();
      this.events.append({ projectId, type: sourceType === 'milestone' ? 'milestone.expansion.proposed' : 'planning.proposed', actor: context.actor, correlationId: context.correlationId, payload: { planningRequestId: id, sourceType, sourceId: source.id, draftId: draft.id, risk: impact.risk } }, () => {
        this.db.prepare(`INSERT INTO planning_requests(id, project_id, source_type, source_id, goal, context_capsule_id, timeline_draft_id, impact_json, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, sourceType, source.id, source.goal, contextCapsule.id, draft.id, JSON.stringify(impact), JSON.stringify(provenance));
        if (source.feature && source.feature.status === 'idea') this.db.prepare("UPDATE features SET status = 'planning', updated_at = datetime('now') WHERE id = ?").run(source.feature.id);
      });
      return this.get(projectId, id);
    });
  }

  async expandMilestone(projectId, milestoneId, input, context) {
    const current = this.timeline.get(projectId);
    const milestone = current.nodes.find((node) => node.id === milestoneId && node.kind === 'milestone');
    if (!milestone) throw notFound('Milestone', milestoneId);
    return this.plan(projectId, { ...input, sourceType: 'milestone', sourceId: milestoneId }, context, { current, transformGraph: (raw) => remapExpansion(current, milestone, raw) });
  }

  get(projectId, requestId) {
    this.projects.get(projectId);
    const row = this.db.prepare('SELECT * FROM planning_requests WHERE project_id = ? AND id = ?').get(projectId, requestId);
    if (!row) throw notFound('Planning request', requestId);
    return {
      id: row.id, projectId: row.project_id, sourceType: row.source_type, sourceId: row.source_id, goal: row.goal,
      status: row.status, impact: JSON.parse(row.impact_json), provenance: JSON.parse(row.provenance_json),
      context: this.contexts.get(projectId, row.context_capsule_id), draft: this.execution.getDraft(projectId, row.timeline_draft_id),
      nodes: this.db.prepare('SELECT timeline_nodes.* FROM planning_request_nodes JOIN timeline_nodes ON timeline_nodes.id = planning_request_nodes.node_id WHERE planning_request_id = ? ORDER BY timeline_nodes.ordinal').all(requestId).map((node) => ({ id: node.id, kind: node.kind, key: node.display_key, title: node.title, parentId: node.parent_id, status: node.status })),
      createdAt: row.created_at, acceptedAt: row.accepted_at
    };
  }

  accept(projectId, requestId, context) {
    const request = this.get(projectId, requestId);
    if (request.status !== 'proposed') throw new AppError('PLANNING_NOT_PROPOSED', 'Only proposed plans can be accepted', { status: 409 });
    return runIdempotent(this.db, context, { command: 'planning.accept', projectId, requestId }, () => {
      this.execution.acceptDraft(projectId, request.draft.id, nested(context, 'timeline'));
      this.events.append({ projectId, type: 'planning.accepted', actor: context.actor, correlationId: context.correlationId, payload: { planningRequestId: requestId, sourceType: request.sourceType, sourceId: request.sourceId } }, () => {
        this.db.prepare("UPDATE planning_requests SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?").run(requestId);
        const insert = this.db.prepare('INSERT OR IGNORE INTO planning_request_nodes(planning_request_id, node_id) VALUES (?, ?)');
        for (const nodeId of request.provenance.producedNodeIds) insert.run(requestId, nodeId);
        if (request.sourceType === 'feature') this.db.prepare("UPDATE features SET status = 'approved', updated_at = datetime('now') WHERE id = ? AND status = 'planning'").run(request.sourceId);
      });
      return this.get(projectId, requestId);
    });
  }
}
