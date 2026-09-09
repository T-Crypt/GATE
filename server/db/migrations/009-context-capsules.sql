CREATE TABLE IF NOT EXISTS context_capsules (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('context', 'planning', 'execution')),
  goal TEXT NOT NULL,
  repository_sha TEXT NOT NULL,
  memory_revision_sha TEXT NOT NULL,
  token_budget INTEGER NOT NULL CHECK(token_budget BETWEEN 512 AND 32000),
  estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens >= 0),
  payload_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_context_capsules_project_created
  ON context_capsules(project_id, created_at DESC);
