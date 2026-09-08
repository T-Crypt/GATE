-- Projects are the top-level container. A project maps to a git repo path on disk.
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  agent_cmd TEXT DEFAULT 'claude',        -- CLI command used to drive the agent for this project
  created_at TEXT DEFAULT (datetime('now'))
);

-- Milestones sit on a project timeline. status: draft | locked | in_progress | done
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  color TEXT DEFAULT '#4f8cff',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  goal_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Numbered prompt steps under a milestone. This is what the "grid" of #1, #2... renders from.
CREATE TABLE IF NOT EXISTS prompt_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  last_run_at TEXT,
  last_output TEXT
);

-- Free-form notes, taggable, optionally linked to a milestone or a git commit.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT DEFAULT '#888888'
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

-- Cached git log entries, refreshed by polling the repo (see server/routes/dashboard.js).
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

-- Simple issue tracker, independent of any external tracker.
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | in_progress | closed
  branch TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- One row per agent session invocation, so output can be replayed after a page refresh.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt_step_id INTEGER REFERENCES prompt_steps(id) ON DELETE SET NULL,
  prompt_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running | done | failed | killed
  output TEXT DEFAULT '',
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);
