import { runIdempotent } from './idempotency.js';
import { MemoryIndexService } from './memory-index-service.js';
import { SemanticSearchService } from './semantic-search-service.js';
import { estimateTokens, trimToBudget } from './token-budget.js';
import { AppError, notFound, validation } from '../domain/errors.js';

const EDGE_TYPES = new Set(['CONTAINS', 'IMPORTS', 'REFERENCES']);
// Containment alone connects every indexed path back to the repository root, so
// structural questions about how code groups and relates ask about the edges a
// developer actually reasons over.
const RELATION_EDGE_TYPES = ['IMPORTS', 'REFERENCES'];
// Centrality and community detection load the whole graph into memory. Real
// repositories stay far below this; anything larger is reported as truncated
// rather than silently analyzed in part.
const GRAPH_NODE_CAP = 5000;
const MAX_PATH_HOPS = 6;
const AFFECTED_QUESTION = /\b(affect|affected|impact|impacts|break|breaks|depend|depends|dependent|dependents|consumer|consumers|blast radius)\b/i;

function decodeNode(row) {
  if (!row) return row;
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.node_type,
    path: row.path,
    sourcePath: row.source_path,
    name: row.name,
    contentHash: row.content_hash,
    metadata: JSON.parse(row.metadata_json),
    provenance: JSON.parse(row.provenance_json),
    indexedSha: row.indexed_sha,
    updatedAt: row.updated_at
  };
}

function decodeEdge(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    type: row.edge_type,
    provenance: JSON.parse(row.provenance_json),
    indexedSha: row.indexed_sha,
    updatedAt: row.updated_at
  };
}

function limit(value, maximum = 100) {
  return Math.max(1, Math.min(Number(value) || 20, maximum));
}

function uniqueNodes(nodes) {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

// Every claim Gate makes about the graph cites a repository location: symbols
// carry the line they were parsed from, everything else carries its path.
function sourceLocation(node) {
  if (node.type === 'symbol') return `${node.sourcePath}:${node.metadata.line}`;
  return node.path || node.name;
}

function nodeLabel(node) {
  if (node.type === 'symbol') return `${node.name} (${node.metadata.kind}) at ${sourceLocation(node)}`;
  return node.path || node.name;
}

function citation(node, extra = {}) {
  return {
    nodeId: node.id,
    type: node.type,
    name: node.name,
    path: node.path,
    sourcePath: node.sourcePath,
    sourceLocation: sourceLocation(node),
    origin: node.provenance.origin,
    ...extra
  };
}

function directoryOf(node) {
  const target = node.type === 'symbol' ? node.sourcePath : node.path;
  const cut = String(target || '').lastIndexOf('/');
  return cut === -1 ? '' : target.slice(0, cut);
}

function commonPrefix(paths) {
  if (!paths.length) return '';
  const segments = paths.map((value) => value.split('/'));
  const shortest = Math.min(...segments.map((parts) => parts.length));
  const shared = [];
  for (let index = 0; index < shortest; index += 1) {
    const candidate = segments[0][index];
    if (!segments.every((parts) => parts[index] === candidate)) break;
    shared.push(candidate);
  }
  return shared.join('/');
}

export class MemoryService {
  constructor({ db, projects, gitAdapter, eventStore, indexService = new MemoryIndexService(), semanticSearch }) {
    this.db = db;
    this.projects = projects;
    this.git = gitAdapter;
    this.events = eventStore;
    this.index = indexService;
    this.semantic = semanticSearch || new SemanticSearchService(db);
  }

  async status(projectId) {
    const project = this.projects.get(projectId);
    const revision = this.db.prepare('SELECT * FROM memory_revisions WHERE project_id = ?').get(projectId);
    const inspected = await this.git.inspect(project.repoPath);
    const counts = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ? AND node_type = 'file') AS files,
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ? AND node_type = 'symbol') AS symbols,
         (SELECT COUNT(*) FROM memory_search WHERE project_id = ?) AS documents,
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ?) AS nodes,
         (SELECT COUNT(*) FROM memory_edges WHERE project_id = ?) AS edges`
    ).get(projectId, projectId, projectId, projectId, projectId);
    return {
      projectId,
      state: revision?.status || 'unindexed',
      repositorySha: inspected.headSha,
      indexedSha: revision?.repository_sha || null,
      stale: !revision || revision.repository_sha !== inspected.headSha,
      qualityLevel: counts.documents > 0 ? 3 : counts.symbols > 0 ? 2 : revision ? 1 : 0,
      counts,
      indexedAt: revision?.indexed_at || null,
      lastError: revision?.last_error || null
    };
  }

  async refresh(projectId, input, context) {
    const project = this.projects.get(projectId);
    const inspected = await this.git.inspect(project.repoPath);
    const prior = this.db.prepare('SELECT repository_sha FROM memory_revisions WHERE project_id = ?').get(projectId);
    let mode = input.force || !prior ? 'full' : 'incremental';
    let changedPaths = [];
    if (mode === 'incremental') {
      if (prior.repository_sha === inspected.headSha) {
        return runIdempotent(
          this.db,
          context,
          { command: 'memory.refresh', projectId, input },
          () => ({ projectId, mode: 'unchanged', changedPaths: [], repositorySha: inspected.headSha })
        );
      }
      changedPaths = await this.git.changedFilesBetween(project.repoPath, prior.repository_sha, inspected.headSha);
      if (changedPaths.includes('.gateignore')) mode = 'full';
    }

    return runIdempotent(
      this.db,
      context,
      { command: 'memory.refresh', projectId, input },
      () => {
        this.events.append({
          projectId,
          type: 'memory.index.started',
          actor: context.actor,
          correlationId: context.correlationId,
          payload: { mode, repositorySha: inspected.headSha, changedPaths }
        });
        try {
          const counts = this.index.replace(this.db, {
            projectId,
            root: inspected.root,
            repositorySha: inspected.headSha,
            mode,
            changedPaths
          });
          this.db.prepare(
            `INSERT INTO memory_revisions(project_id, repository_sha, status, indexed_at, file_count, node_count, edge_count, last_error)
             VALUES (?, ?, 'ready', datetime('now'), ?, ?, ?, NULL)
             ON CONFLICT(project_id) DO UPDATE SET
               repository_sha = excluded.repository_sha, status = excluded.status, indexed_at = excluded.indexed_at,
               file_count = excluded.file_count, node_count = excluded.node_count, edge_count = excluded.edge_count,
               last_error = NULL`
          ).run(projectId, inspected.headSha, counts.files, counts.nodes, counts.edges);
          this.events.append({
            projectId,
            type: 'memory.index.completed',
            actor: context.actor,
            correlationId: context.correlationId,
            payload: { mode, repositorySha: inspected.headSha, changedPaths, counts }
          });
          return { projectId, mode, repositorySha: inspected.headSha, changedPaths, counts };
        } catch (error) {
          this.db.prepare(
            `INSERT INTO memory_revisions(project_id, repository_sha, status, indexed_at, last_error)
             VALUES (?, ?, 'failed', datetime('now'), ?)
             ON CONFLICT(project_id) DO UPDATE SET status = excluded.status, last_error = excluded.last_error, indexed_at = excluded.indexed_at`
          ).run(projectId, inspected.headSha, String(error.message).slice(0, 2000));
          this.events.append({
            projectId,
            type: 'memory.index.failed',
            actor: context.actor,
            correlationId: context.correlationId,
            payload: { mode, repositorySha: inspected.headSha, message: String(error.message).slice(0, 500) }
          });
          throw error;
        }
      }
    );
  }

  search(projectId, { query, limit: requestedLimit, type } = {}) {
    this.projects.get(projectId);
    const normalized = String(query || '').trim();
    if (!normalized) return { projectId, query: normalized, items: [] };
    const terms = normalized.split(/\s+/).slice(0, 8);
    const clauses = terms.map(() => '(path LIKE ? OR name LIKE ?)').join(' AND ');
    const parameters = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
    const typeClause = type ? ' AND node_type = ?' : '';
    if (type) parameters.push(type);
    parameters.push(limit(requestedLimit));
    const rows = this.db.prepare(
      `SELECT * FROM memory_nodes WHERE project_id = ? AND (${clauses})${typeClause}
       ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 WHEN lower(path) = lower(?) THEN 1 ELSE 2 END,
         CASE node_type WHEN 'symbol' THEN 0 WHEN 'file' THEN 1 WHEN 'directory' THEN 2 ELSE 3 END, path
       LIMIT ?`
    ).all(projectId, ...parameters.slice(0, -1), normalized, normalized, Math.min(parameters.at(-1) * 2, 200));
    const semantic = this.semantic.search(projectId, {
      query: normalized,
      limit: Math.min(limit(requestedLimit) * 3, 200),
      type
    });
    const semanticById = new Map(semantic.map((item) => [item.nodeId, item]));
    const candidates = new Map();
    for (const row of rows) {
      const node = decodeNode(row);
      const exactName = node.name.toLowerCase() === normalized.toLowerCase();
      const exactPath = node.path.toLowerCase() === normalized.toLowerCase();
      const semanticMatch = semanticById.get(node.id);
      candidates.set(node.id, {
        ...node,
        score: exactName ? 1 : exactPath ? 0.96 : 0.86,
        matchStrategy: semanticMatch ? 'hybrid' : 'structural',
        matchReasons: [exactName ? 'Exact node name match' : exactPath ? 'Exact path match' : 'Path or node name match', ...(semanticMatch?.reasons || [])]
      });
    }
    const semanticOnlyIds = semantic.map((item) => item.nodeId).filter((id) => !candidates.has(id));
    if (semanticOnlyIds.length) {
      const semanticNodes = this.db.prepare(
        `SELECT * FROM memory_nodes WHERE project_id = ? AND id IN (${semanticOnlyIds.map(() => '?').join(',')})`
      ).all(projectId, ...semanticOnlyIds).map(decodeNode);
      for (const node of semanticNodes) {
        const match = semanticById.get(node.id);
        candidates.set(node.id, {
          ...node,
          score: match.score,
          matchStrategy: 'semantic',
          matchReasons: match.reasons
        });
      }
    }
    const items = [...candidates.values()]
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit(requestedLimit));
    return { projectId, query: normalized, items };
  }

  neighbors(projectId, nodeId, { depth = 1, edgeTypes } = {}) {
    this.projects.get(projectId);
    const root = this.db.prepare('SELECT * FROM memory_nodes WHERE project_id = ? AND id = ?').get(projectId, nodeId);
    if (!root) throw notFound('Memory node', nodeId);
    const maxDepth = Math.max(1, Math.min(Number(depth) || 1, 4));
    const selectedEdgeTypes = this.#edgeTypes(edgeTypes);
    const seen = new Set([nodeId]);
    const edges = new Map();
    let frontier = [nodeId];
    for (let level = 0; level < maxDepth && frontier.length; level += 1) {
      const placeholders = frontier.map(() => '?').join(',');
      const edgePlaceholders = selectedEdgeTypes.map(() => '?').join(',');
      const found = this.db.prepare(
        `SELECT * FROM memory_edges WHERE project_id = ? AND edge_type IN (${edgePlaceholders})
         AND (source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))`
      ).all(projectId, ...selectedEdgeTypes, ...frontier, ...frontier);
      frontier = [];
      for (const edge of found) {
        edges.set(edge.id, decodeEdge(edge));
        for (const id of [edge.source_node_id, edge.target_node_id]) {
          if (!seen.has(id)) {
            seen.add(id);
            frontier.push(id);
          }
        }
      }
    }
    const ids = [...seen];
    const nodes = this.db.prepare(
      `SELECT * FROM memory_nodes WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY path`
    ).all(projectId, ...ids).map(decodeNode);
    return { projectId, node: decodeNode(root), nodes, edges: [...edges.values()], edgeTypes: selectedEdgeTypes };
  }

  impact(projectId, { query, limit: requestedLimit } = {}) {
    const normalized = String(query || '').trim();
    const candidates = this.search(projectId, { query: normalized, limit: limit(requestedLimit, 25) }).items
      .filter((node) => ['file', 'symbol'].includes(node.type));
    const exactMatches = candidates.filter((node) => node.score >= 0.95);
    const matches = exactMatches.length ? exactMatches : candidates;
    const matchedSymbols = matches.filter((node) => node.type === 'symbol');
    const matchedFiles = matches.filter((node) => node.type === 'file');
    const symbolSourcePaths = [...new Set(matchedSymbols.map((node) => node.sourcePath))];
    const sourceFiles = symbolSourcePaths.length
      ? this.db.prepare(
        `SELECT * FROM memory_nodes WHERE project_id = ? AND node_type = 'file'
         AND path IN (${symbolSourcePaths.map(() => '?').join(',')})`
      ).all(projectId, ...symbolSourcePaths).map(decodeNode)
      : [];
    const declaringFiles = uniqueNodes([...matchedFiles, ...sourceFiles]);
    const seedIds = new Set([...matches, ...declaringFiles].map((node) => node.id));
    const discovered = new Map();
    const edgeMap = new Map();
    const reasons = {};
    for (const node of matches) reasons[node.id] = [`Direct match for “${normalized}”`];
    for (const node of declaringFiles) {
      reasons[node.id] ||= [];
      if (!reasons[node.id].length) reasons[node.id].push(`Declares matching symbol “${matchedSymbols.find((symbol) => symbol.sourcePath === node.path)?.name}”`);
    }

    let frontier = [...seedIds];
    for (let depth = 0; depth < 2 && frontier.length; depth += 1) {
      const placeholders = frontier.map(() => '?').join(',');
      const found = this.db.prepare(
        `SELECT * FROM memory_edges
         WHERE project_id = ? AND edge_type IN ('IMPORTS', 'REFERENCES')
           AND target_node_id IN (${placeholders})`
      ).all(projectId, ...frontier).map(decodeEdge);
      const sourceIds = [...new Set(found.map((edge) => edge.sourceNodeId).filter((id) => !seedIds.has(id) && !discovered.has(id)))];
      const sourceNodes = sourceIds.length
        ? this.db.prepare(
          `SELECT * FROM memory_nodes WHERE project_id = ? AND id IN (${sourceIds.map(() => '?').join(',')})`
        ).all(projectId, ...sourceIds).map(decodeNode)
        : [];
      for (const node of sourceNodes) discovered.set(node.id, node);
      for (const edge of found) {
        edgeMap.set(edge.id, edge);
        reasons[edge.sourceNodeId] ||= [];
        const description = edge.type === 'IMPORTS' ? 'Imports an affected file' : 'References an affected symbol';
        if (!reasons[edge.sourceNodeId].includes(description)) reasons[edge.sourceNodeId].push(description);
      }
      frontier = sourceNodes.map((node) => node.id);
    }

    const affectedFiles = [...discovered.values()].filter((node) => node.type === 'file');
    const tests = affectedFiles.filter((node) => node.metadata.isTest).sort((left, right) => left.path.localeCompare(right.path));
    const dependents = affectedFiles.filter((node) => !node.metadata.isTest).sort((left, right) => left.path.localeCompare(right.path));
    const productionCount = uniqueNodes([...declaringFiles.filter((node) => !node.metadata.isTest), ...dependents]).length;
    return {
      projectId,
      query: normalized,
      risk: productionCount > 12 ? 'high' : productionCount > 4 ? 'medium' : 'low',
      directMatches: matches,
      declaringFiles: declaringFiles.sort((left, right) => left.path.localeCompare(right.path)),
      dependents,
      tests,
      symbols: matchedSymbols,
      edges: [...edgeMap.values()],
      reasons
    };
  }

  #edgeTypes(edgeTypes, fallback = [...EDGE_TYPES]) {
    const selected = edgeTypes?.length ? [...new Set(edgeTypes.map((type) => String(type).toUpperCase()))] : [...fallback];
    if (selected.some((type) => !EDGE_TYPES.has(type))) {
      throw validation('Unknown memory edge type', { edgeTypes: selected });
    }
    return selected;
  }

  #edgesTouching(projectId, frontier, edgeTypes) {
    const nodePlaceholders = frontier.map(() => '?').join(',');
    const typePlaceholders = edgeTypes.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM memory_edges WHERE project_id = ? AND edge_type IN (${typePlaceholders})
       AND (source_node_id IN (${nodePlaceholders}) OR target_node_id IN (${nodePlaceholders}))`
    ).all(projectId, ...edgeTypes, ...frontier, ...frontier).map(decodeEdge);
  }

  // Whole-graph analysis loads persisted rows only. Nothing here infers an edge
  // the indexer did not record.
  #graph(projectId, edgeTypes, fallback) {
    const selected = this.#edgeTypes(edgeTypes, fallback);
    const totalNodes = this.db.prepare('SELECT COUNT(*) AS total FROM memory_nodes WHERE project_id = ?').get(projectId).total;
    const rows = this.db.prepare('SELECT * FROM memory_nodes WHERE project_id = ? ORDER BY path LIMIT ?').all(projectId, GRAPH_NODE_CAP);
    const nodes = rows.map(decodeNode);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = this.db.prepare(
      `SELECT * FROM memory_edges WHERE project_id = ? AND edge_type IN (${selected.map(() => '?').join(',')})`
    ).all(projectId, ...selected).map(decodeEdge)
      .filter((edge) => byId.has(edge.sourceNodeId) && byId.has(edge.targetNodeId));
    return { nodes, byId, edges, edgeTypes: selected, totalNodes, truncated: totalNodes > nodes.length };
  }

  #degrees(graph) {
    const degrees = new Map(graph.nodes.map((node) => [node.id, { in: 0, out: 0 }]));
    for (const edge of graph.edges) {
      degrees.get(edge.sourceNodeId).out += 1;
      degrees.get(edge.targetNodeId).in += 1;
    }
    return degrees;
  }

  explain(projectId, nodeId, { query } = {}) {
    this.projects.get(projectId);
    const row = this.db.prepare('SELECT * FROM memory_nodes WHERE project_id = ? AND id = ?').get(projectId, nodeId);
    if (!row) throw notFound('Memory node', nodeId);
    const node = decodeNode(row);
    const normalized = String(query || '').trim();
    const match = normalized
      ? this.search(projectId, { query: normalized, limit: 50 }).items.find((item) => item.id === nodeId)
      : undefined;
    const graph = this.neighbors(projectId, nodeId, { depth: 1 });
    const related = new Map(graph.nodes.map((item) => [item.id, item]));
    const relationships = graph.edges.map((edge) => {
      const outgoing = edge.sourceNodeId === nodeId;
      const other = related.get(outgoing ? edge.targetNodeId : edge.sourceNodeId);
      return {
        edgeId: edge.id,
        type: edge.type,
        direction: outgoing ? 'outgoing' : 'incoming',
        origin: edge.provenance.origin,
        nodeId: other?.id ?? (outgoing ? edge.targetNodeId : edge.sourceNodeId),
        sourceLocation: other ? sourceLocation(other) : null,
        label: other ? nodeLabel(other) : null
      };
    });
    const counts = relationships.reduce((totals, relation) => ({ ...totals, [relation.type]: (totals[relation.type] || 0) + 1 }), {});
    const statements = [
      `${nodeLabel(node)} is indexed as a ${node.type} node from ${node.provenance.origin === 'static_parser' ? 'static source parsing' : 'repository filesystem indexing'} at revision ${node.indexedSha.slice(0, 12)}.`
    ];
    if (normalized) {
      statements.push(match
        ? `It matched “${normalized}” by ${match.matchStrategy} ranking: ${match.matchReasons.join('; ')}.`
        : `It is not among the current search results for “${normalized}”.`);
    }
    statements.push(relationships.length
      ? `It carries ${relationships.length} recorded edge${relationships.length === 1 ? '' : 's'} (${Object.entries(counts).map(([type, count]) => `${count} ${type}`).join(', ')}).`
      : 'It has no recorded structural edges.');
    return {
      projectId,
      node,
      sourceLocation: sourceLocation(node),
      query: normalized,
      matched: Boolean(match),
      matchStrategy: match?.matchStrategy || null,
      score: match?.score ?? null,
      matchReasons: match?.matchReasons || [],
      provenance: node.provenance,
      relationships,
      edgeCounts: counts,
      summary: statements.join(' ')
    };
  }

  godNodes(projectId, { limit: requestedLimit, edgeTypes } = {}) {
    this.projects.get(projectId);
    const graph = this.#graph(projectId, edgeTypes);
    const degrees = this.#degrees(graph);
    const items = graph.nodes
      .map((node) => {
        const degree = degrees.get(node.id);
        return { ...node, sourceLocation: sourceLocation(node), inDegree: degree.in, outDegree: degree.out, degree: degree.in + degree.out };
      })
      .filter((node) => node.degree > 0)
      .sort((left, right) => right.degree - left.degree || right.inDegree - left.inDegree || left.path.localeCompare(right.path))
      .slice(0, limit(requestedLimit, 100));
    return {
      projectId,
      edgeTypes: graph.edgeTypes,
      analyzedNodes: graph.nodes.length,
      totalNodes: graph.totalNodes,
      truncated: graph.truncated,
      items
    };
  }

  communities(projectId, { limit: requestedLimit, edgeTypes, members: requestedMembers } = {}) {
    this.projects.get(projectId);
    const graph = this.#graph(projectId, edgeTypes, RELATION_EDGE_TYPES);
    const degrees = this.#degrees(graph);
    const parent = new Map(graph.nodes.map((node) => [node.id, node.id]));
    const find = (start) => {
      let root = start;
      while (parent.get(root) !== root) root = parent.get(root);
      let cursor = start;
      while (parent.get(cursor) !== root) {
        const next = parent.get(cursor);
        parent.set(cursor, root);
        cursor = next;
      }
      return root;
    };
    for (const edge of graph.edges) {
      const left = find(edge.sourceNodeId);
      const right = find(edge.targetNodeId);
      if (left !== right) parent.set(left, right);
    }
    const grouped = new Map();
    for (const node of graph.nodes) {
      const root = find(node.id);
      if (!grouped.has(root)) grouped.set(root, []);
      grouped.get(root).push(node);
    }
    const memberCap = limit(requestedMembers ?? 10, 100);
    const connected = [...grouped.values()].filter((group) => group.length > 1);
    const items = connected
      .sort((left, right) => right.length - left.length)
      .slice(0, limit(requestedLimit, 50))
      .map((group, index) => {
        const ranked = [...group].sort((left, right) => (degrees.get(right.id).in + degrees.get(right.id).out) - (degrees.get(left.id).in + degrees.get(left.id).out) || left.path.localeCompare(right.path));
        const directories = [...new Set(group.map(directoryOf).filter(Boolean))];
        return {
          id: `community-${index + 1}`,
          size: group.length,
          label: commonPrefix(directories) || nodeLabel(ranked[0]),
          directories: directories.slice(0, 10),
          members: ranked.slice(0, memberCap).map((node) => ({
            ...node,
            sourceLocation: sourceLocation(node),
            degree: degrees.get(node.id).in + degrees.get(node.id).out
          }))
        };
      });
    return {
      projectId,
      edgeTypes: graph.edgeTypes,
      analyzedNodes: graph.nodes.length,
      totalNodes: graph.totalNodes,
      truncated: graph.truncated,
      count: connected.length,
      isolatedNodes: grouped.size - connected.length,
      items
    };
  }

  // Bidirectional breadth-first search over persisted edges. Expansion always
  // grows the smaller side and stops at the hop cap rather than walking the
  // whole repository looking for a link that is not recorded.
  path(projectId, fromNodeId, toNodeId, { edgeTypes, maxHops } = {}) {
    this.projects.get(projectId);
    const read = (id) => {
      const row = this.db.prepare('SELECT * FROM memory_nodes WHERE project_id = ? AND id = ?').get(projectId, id);
      if (!row) throw notFound('Memory node', id);
      return decodeNode(row);
    };
    const from = read(fromNodeId);
    const to = read(toNodeId);
    const selected = this.#edgeTypes(edgeTypes);
    const cap = Math.max(1, Math.min(Number(maxHops) || MAX_PATH_HOPS, MAX_PATH_HOPS));
    if (fromNodeId === toNodeId) {
      return { projectId, from, to, hops: 0, edgeTypes: selected, nodes: [{ ...from, sourceLocation: sourceLocation(from) }], edges: [] };
    }

    const forward = new Map([[fromNodeId, null]]);
    const backward = new Map([[toNodeId, null]]);
    let forwardFrontier = [fromNodeId];
    let backwardFrontier = [toNodeId];
    let forwardHops = 0;
    let backwardHops = 0;
    let meeting = null;
    while (!meeting && forwardHops + backwardHops < cap) {
      const growForward = forwardFrontier.length > 0 && (backwardFrontier.length === 0 || forwardFrontier.length <= backwardFrontier.length);
      const frontier = growForward ? forwardFrontier : backwardFrontier;
      if (!frontier.length) break;
      const visited = growForward ? forward : backward;
      const opposite = growForward ? backward : forward;
      const frontierSet = new Set(frontier);
      const next = [];
      for (const edge of this.#edgesTouching(projectId, frontier, selected)) {
        for (const [near, far] of [[edge.sourceNodeId, edge.targetNodeId], [edge.targetNodeId, edge.sourceNodeId]]) {
          if (!frontierSet.has(near) || visited.has(far)) continue;
          visited.set(far, { previous: near, edge });
          next.push(far);
          if (opposite.has(far) && !meeting) meeting = far;
        }
      }
      if (growForward) {
        forwardFrontier = next;
        forwardHops += 1;
      } else {
        backwardFrontier = next;
        backwardHops += 1;
      }
    }
    if (!meeting) {
      throw new AppError('MEMORY_PATH_NOT_FOUND', `No recorded path between the two memory nodes within ${cap} hops`, {
        status: 404,
        details: { fromNodeId, toNodeId, maxHops: cap, edgeTypes: selected }
      });
    }

    const orderedIds = [meeting];
    const edges = [];
    for (let cursor = forward.get(meeting); cursor; cursor = forward.get(cursor.previous)) {
      orderedIds.unshift(cursor.previous);
      edges.unshift(cursor.edge);
    }
    for (let cursor = backward.get(meeting); cursor; cursor = backward.get(cursor.previous)) {
      orderedIds.push(cursor.previous);
      edges.push(cursor.edge);
    }
    const rows = this.db.prepare(
      `SELECT * FROM memory_nodes WHERE project_id = ? AND id IN (${orderedIds.map(() => '?').join(',')})`
    ).all(projectId, ...orderedIds).map(decodeNode);
    const byId = new Map(rows.map((node) => [node.id, node]));
    return {
      projectId,
      from,
      to,
      hops: edges.length,
      edgeTypes: selected,
      nodes: orderedIds.map((id) => ({ ...byId.get(id), sourceLocation: sourceLocation(byId.get(id)) })),
      edges
    };
  }

  // The natural-language entry point: seed with retrieval, widen along recorded
  // edges only, and answer with citations back to repository locations.
  query(projectId, { question, budget } = {}) {
    this.projects.get(projectId);
    const normalized = String(question || '').trim();
    if (!normalized) throw validation('question is required', { field: 'question' });
    const tokenBudget = Math.max(256, Math.min(Math.trunc(Number(budget) || 2000), 32_000));
    const search = this.search(projectId, { query: normalized, limit: 12 });
    const wantsImpact = AFFECTED_QUESTION.test(normalized);
    const impact = wantsImpact && search.items.length ? this.impact(projectId, { query: normalized, limit: 25 }) : null;

    const cited = new Map();
    const edges = new Map();
    const record = (node, relevance, reasons) => {
      const existing = cited.get(node.id);
      if (existing) {
        existing.reasons = [...new Set([...existing.reasons, ...reasons])];
        existing.relevance = Math.max(existing.relevance, relevance);
        return;
      }
      cited.set(node.id, citation(node, { relevance, reasons: [...new Set(reasons)] }));
    };
    for (const item of search.items) record(item, item.score, item.matchReasons);
    for (const seed of search.items.slice(0, 5)) {
      const graph = this.neighbors(projectId, seed.id, { depth: 1 });
      for (const edge of graph.edges) edges.set(edge.id, edge);
      for (const node of graph.nodes) {
        if (node.id === seed.id) continue;
        record(node, seed.score * 0.5, [`Connected to ${nodeLabel(seed)} by a recorded edge`]);
      }
    }
    if (impact) {
      for (const edge of impact.edges) edges.set(edge.id, edge);
      for (const node of [...impact.declaringFiles, ...impact.dependents, ...impact.tests]) {
        record(node, 0.8, impact.reasons[node.id] || ['Reached through recorded import or reference edges']);
      }
    }

    const citations = [...cited.values()].sort((left, right) => right.relevance - left.relevance || left.sourceLocation.localeCompare(right.sourceLocation));
    const top = search.items[0];
    const statements = [];
    if (!top) {
      statements.push({ text: `GATE Memory has no indexed node matching “${normalized}”.`, nodeIds: [] });
    } else {
      statements.push({
        text: `The closest indexed match for “${normalized}” is ${nodeLabel(top)}, retrieved by ${top.matchStrategy} ranking (${top.matchReasons.join('; ')}).`,
        nodeIds: [top.id]
      });
      const edgeCounts = [...edges.values()].reduce((totals, edge) => ({ ...totals, [edge.type]: (totals[edge.type] || 0) + 1 }), {});
      if (edges.size) {
        statements.push({
          text: `Its neighborhood holds ${edges.size} recorded edge${edges.size === 1 ? '' : 's'} (${Object.entries(edgeCounts).map(([type, count]) => `${count} ${type}`).join(', ')}).`,
          nodeIds: [top.id]
        });
      }
      if (impact) {
        statements.push({
          text: `Structural impact is ${impact.risk}: ${impact.dependents.length} production dependent${impact.dependents.length === 1 ? '' : 's'} and ${impact.tests.length} test${impact.tests.length === 1 ? '' : 's'} reach it through import and reference edges.`,
          nodeIds: [...impact.dependents, ...impact.tests].map((node) => node.id)
        });
      }
    }

    // trimToBudget mutates the payload it is handed, so the pre-trim totals are
    // captured before the loop can shorten them.
    const totalCitations = citations.length;
    const payload = trimToBudget(
      { projectId, question: normalized, statements, citations, edges: [...edges.values()].map((edge) => ({ id: edge.id, type: edge.type, sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, origin: edge.provenance.origin })) },
      tokenBudget,
      [
        (value) => {
          if (value.citations.length <= 1) return false;
          value.citations.pop();
          return true;
        },
        (value) => {
          if (!value.edges.length) return false;
          value.edges.pop();
          return true;
        },
        (value) => {
          if (value.statements.length <= 1) return false;
          value.statements.pop();
          return true;
        }
      ],
      (value) => value
    );
    const keptIds = new Set(payload.citations.map((item) => item.nodeId));
    payload.edges = payload.edges.filter((edge) => keptIds.has(edge.sourceNodeId) && keptIds.has(edge.targetNodeId));
    return {
      ...payload,
      answer: payload.statements.map((statement) => statement.text).join(' '),
      tokenBudget,
      estimatedTokens: estimateTokens(payload),
      truncated: payload.citations.length < totalCitations
    };
  }
}
