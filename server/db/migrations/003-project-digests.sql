CREATE TABLE IF NOT EXISTS project_digests (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  file_tree_json TEXT NOT NULL,
  milestones_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issue_tags (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(issue_id, tag_id)
);
