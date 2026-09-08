CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  agent_cmd TEXT DEFAULT 'claude',
  base_branch TEXT NOT NULL DEFAULT 'main',
  production_branch TEXT,
  stable_branch TEXT,
  protected_branches_json TEXT NOT NULL DEFAULT '["main"]',
  interaction_level TEXT NOT NULL DEFAULT 'assist',
  provider_kind TEXT NOT NULL DEFAULT 'claude',
  provider_config_json TEXT NOT NULL DEFAULT '{}',
  last_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_events_project_sequence
  ON events(project_id, sequence);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(actor_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS timeline_nodes (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('milestone', 'step')),
  parent_id TEXT REFERENCES timeline_nodes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0, 1)),
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_timeline_nodes_project_parent
  ON timeline_nodes(project_id, parent_id, ordinal);

CREATE TABLE IF NOT EXISTS timeline_edges (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL REFERENCES timeline_nodes(id) ON DELETE CASCADE,
  to_node_id TEXT NOT NULL REFERENCES timeline_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'depends_on',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, from_node_id, to_node_id, type)
);

CREATE INDEX IF NOT EXISTS idx_timeline_edges_target
  ON timeline_edges(project_id, to_node_id);

CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES timeline_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  blocking INTEGER NOT NULL DEFAULT 1 CHECK(blocking IN (0, 1)),
  required_evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gates_node_status ON gates(node_id, status);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  file_scope_json TEXT NOT NULL DEFAULT '[]',
  command TEXT,
  exit_code INTEGER,
  output TEXT NOT NULL DEFAULT '',
  artifact_path TEXT,
  status TEXT NOT NULL DEFAULT 'fresh',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
  actor_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES timeline_nodes(id) ON DELETE SET NULL,
  provider_kind TEXT NOT NULL,
  provider_session_id TEXT,
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_project_status ON runs(project_id, status);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  event_sequence INTEGER,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_project_id ON activity(project_id, id DESC);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  branch TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id INTEGER,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT NOT NULL DEFAULT '#888888'
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(note_id, tag_id)
);

CREATE TABLE IF NOT EXISTS git_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_hash TEXT NOT NULL,
  author TEXT,
  message TEXT,
  branch TEXT,
  committed_at TEXT,
  UNIQUE(project_id, commit_hash)
);
