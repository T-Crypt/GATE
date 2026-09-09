ALTER TABLE projects ADD COLUMN branch_prefix TEXT NOT NULL DEFAULT 'work/gate-';

CREATE TABLE IF NOT EXISTS remote_prs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0,
  head_ref TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  author TEXT,
  body TEXT,
  html_url TEXT,
  updated_at TEXT,
  UNIQUE(project_id, number)
);

CREATE TABLE IF NOT EXISTS remote_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  assignee TEXT,
  html_url TEXT,
  updated_at TEXT,
  UNIQUE(project_id, number)
);
