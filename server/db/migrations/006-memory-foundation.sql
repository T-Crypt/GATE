CREATE TABLE IF NOT EXISTS memory_revisions (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  repository_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  file_count INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS memory_nodes (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK(node_type IN ('repository', 'directory', 'file')),
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  content_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  indexed_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, node_type, path)
);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_project_type_path
  ON memory_nodes(project_id, node_type, path);

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK(edge_type IN ('CONTAINS')),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  indexed_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, source_node_id, target_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_memory_edges_project_source
  ON memory_edges(project_id, source_node_id);

CREATE INDEX IF NOT EXISTS idx_memory_edges_project_target
  ON memory_edges(project_id, target_node_id);
