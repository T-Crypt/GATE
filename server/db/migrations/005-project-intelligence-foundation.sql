ALTER TABLE projects ADD COLUMN stage TEXT NOT NULL DEFAULT 'active'
  CHECK(stage IN ('greenfield', 'active', 'maintenance'));

CREATE TABLE IF NOT EXISTS project_instruction_documents (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK(file_name IN ('AGENTS.md', 'CLAUDE.md')),
  managed_contract_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('valid', 'corrupt', 'missing', 'untracked')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project_id, file_name)
);
