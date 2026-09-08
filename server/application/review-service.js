function parse(row) {
  return {
    ...row,
    blocking: row.blocking === undefined ? undefined : Boolean(row.blocking),
    requiredEvidence: row.required_evidence_json
      ? JSON.parse(row.required_evidence_json)
      : undefined,
    fileScope: row.file_scope_json ? JSON.parse(row.file_scope_json) : undefined
  };
}

export class ReviewService {
  constructor(db) {
    this.db = db;
  }

  get(projectId) {
    return {
      gates: this.db.prepare('SELECT * FROM gates WHERE project_id = ? ORDER BY created_at').all(projectId).map(parse),
      evidence: this.db.prepare('SELECT * FROM evidence WHERE project_id = ? ORDER BY created_at DESC').all(projectId).map(parse),
      approvals: this.db.prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC').all(projectId).map(parse),
      runs: this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 25').all(projectId)
    };
  }
}
