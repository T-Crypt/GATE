ALTER TABLE timeline_nodes ADD COLUMN display_key TEXT NOT NULL DEFAULT '';
ALTER TABLE timeline_nodes ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX idx_timeline_nodes_project_key
  ON timeline_nodes(project_id, display_key)
  WHERE display_key <> '';

CREATE TABLE timeline_drafts (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  graph_json TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
