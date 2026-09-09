function terms(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])].slice(0, 12);
}

function matchExpression(query) {
  return terms(query).map((term) => `"${term.replace(/"/g, '""')}"*`).join(' OR ');
}

function includesAll(value, queryTerms) {
  const normalized = String(value || '').toLowerCase();
  return queryTerms.every((term) => normalized.includes(term));
}

export class SemanticSearchService {
  constructor(db) {
    this.db = db;
  }

  search(projectId, { query, limit = 50, type } = {}) {
    const queryTerms = terms(query);
    const expression = matchExpression(query);
    if (!expression) return [];
    const typeClause = type ? ' AND node_type = ?' : '';
    const parameters = [expression, projectId];
    if (type) parameters.push(type);
    parameters.push(Math.max(1, Math.min(Number(limit) || 50, 200)));
    const rows = this.db.prepare(
      `SELECT node_id, node_type, name, path, content, bm25(memory_search, 8.0, 4.0, 1.0) AS rank
       FROM memory_search
       WHERE memory_search MATCH ? AND project_id = ?${typeClause}
       ORDER BY rank
       LIMIT ?`
    ).all(...parameters);
    return rows.map((row, index) => {
      const nameMatch = includesAll(row.name, queryTerms);
      const pathMatch = includesAll(row.path, queryTerms);
      const coverage = queryTerms.filter((term) => String(row.content || '').toLowerCase().includes(term)).length / queryTerms.length;
      return {
        nodeId: row.node_id,
        score: Math.min(0.84, 0.52 + (coverage * 0.22) + (nameMatch ? 0.08 : 0) + (pathMatch ? 0.04 : 0) - (index * 0.001)),
        reasons: [nameMatch || pathMatch ? 'Full-text name or path match' : 'Source content match']
      };
    });
  }
}
