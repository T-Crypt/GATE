import { runIdempotent } from './idempotency.js';
import { MemoryIndexService } from './memory-index-service.js';
import { notFound } from '../domain/errors.js';

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

export class MemoryService {
  constructor({ db, projects, gitAdapter, eventStore, indexService = new MemoryIndexService() }) {
    this.db = db;
    this.projects = projects;
    this.git = gitAdapter;
    this.events = eventStore;
    this.index = indexService;
  }

  async status(projectId) {
    const project = this.projects.get(projectId);
    const revision = this.db.prepare('SELECT * FROM memory_revisions WHERE project_id = ?').get(projectId);
    const inspected = await this.git.inspect(project.repoPath);
    const counts = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ? AND node_type = 'file') AS files,
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ? AND node_type = 'symbol') AS symbols,
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ?) AS nodes,
         (SELECT COUNT(*) FROM memory_edges WHERE project_id = ?) AS edges`
    ).get(projectId, projectId, projectId, projectId);
    return {
      projectId,
      state: revision?.status || 'unindexed',
      repositorySha: inspected.headSha,
      indexedSha: revision?.repository_sha || null,
      stale: !revision || revision.repository_sha !== inspected.headSha,
      qualityLevel: counts.symbols > 0 ? 2 : revision ? 1 : 0,
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
    ).all(projectId, ...parameters.slice(0, -1), normalized, normalized, parameters.at(-1));
    return { projectId, query: normalized, items: rows.map(decodeNode) };
  }

  neighbors(projectId, nodeId, { depth = 1 } = {}) {
    this.projects.get(projectId);
    const root = this.db.prepare('SELECT * FROM memory_nodes WHERE project_id = ? AND id = ?').get(projectId, nodeId);
    if (!root) throw notFound('Memory node', nodeId);
    const maxDepth = Math.max(1, Math.min(Number(depth) || 1, 4));
    const seen = new Set([nodeId]);
    const edges = [];
    let frontier = [nodeId];
    for (let level = 0; level < maxDepth && frontier.length; level += 1) {
      const placeholders = frontier.map(() => '?').join(',');
      const found = this.db.prepare(
        `SELECT * FROM memory_edges WHERE project_id = ? AND (source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))`
      ).all(projectId, ...frontier, ...frontier);
      frontier = [];
      for (const edge of found) {
        edges.push(decodeEdge(edge));
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
    return { projectId, node: decodeNode(root), nodes, edges };
  }

  impact(projectId, { query, limit: requestedLimit } = {}) {
    const normalized = String(query || '').trim();
    const matches = this.search(projectId, { query: normalized, limit: limit(requestedLimit, 25) }).items
      .filter((node) => ['file', 'symbol'].includes(node.type));
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
}
