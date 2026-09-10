-- Inbox items are derived at read time from planning_requests and runs, so the
-- inbox can never disagree with the records it describes. The only fact those
-- records cannot express is a human deciding an item needs no action, so that
-- decision — and nothing else — is stored here, keyed by the derived item key.
CREATE TABLE inbox_dismissals (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project_id, item_key)
);

CREATE INDEX idx_inbox_dismissals_project ON inbox_dismissals(project_id, dismissed_at DESC);
