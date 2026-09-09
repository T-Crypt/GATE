DROP INDEX IF EXISTS idx_memory_nodes_project_type_path;
DROP INDEX IF EXISTS idx_memory_edges_project_source;
DROP INDEX IF EXISTS idx_memory_edges_project_target;

ALTER TABLE memory_nodes RENAME TO memory_nodes_v1;
ALTER TABLE memory_edges RENAME TO memory_edges_v1;

CREATE TABLE memory_nodes (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK(node_type IN ('repository', 'directory', 'file', 'symbol')),
  path TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  content_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  indexed_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, node_type, path)
);

INSERT INTO memory_nodes(
  id, project_id, node_type, path, source_path, name, content_hash,
  metadata_json, provenance_json, indexed_sha, updated_at
)
SELECT
  id, project_id, node_type, path, path, name, content_hash,
  metadata_json, provenance_json, indexed_sha, updated_at
FROM memory_nodes_v1;

CREATE TABLE memory_edges (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK(edge_type IN ('CONTAINS', 'IMPORTS', 'REFERENCES')),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  indexed_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, source_node_id, target_node_id, edge_type)
);

INSERT INTO memory_edges(
  id, project_id, source_node_id, target_node_id, edge_type,
  provenance_json, indexed_sha, updated_at
)
SELECT
  id, project_id, source_node_id, target_node_id, edge_type,
  provenance_json, indexed_sha, updated_at
FROM memory_edges_v1;

DROP TABLE memory_edges_v1;
DROP TABLE memory_nodes_v1;

CREATE INDEX idx_memory_nodes_project_type_path
  ON memory_nodes(project_id, node_type, path);

CREATE INDEX idx_memory_nodes_project_source
  ON memory_nodes(project_id, source_path, node_type);

CREATE INDEX idx_memory_edges_project_source
  ON memory_edges(project_id, source_node_id);

CREATE INDEX idx_memory_edges_project_target
  ON memory_edges(project_id, target_node_id);
