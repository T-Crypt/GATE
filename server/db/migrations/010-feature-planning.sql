CREATE TABLE features (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idea' CHECK(status IN ('idea','planning','approved','in_progress','blocked','review','complete','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_features_project_status ON features(project_id, status, updated_at DESC);

CREATE TABLE planning_requests (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN ('feature','issue','milestone')),
  source_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  context_capsule_id TEXT NOT NULL REFERENCES context_capsules(id),
  timeline_draft_id TEXT NOT NULL REFERENCES timeline_drafts(id),
  impact_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
CREATE UNIQUE INDEX idx_planning_one_proposed_source
  ON planning_requests(project_id, source_type, source_id) WHERE status = 'proposed';
CREATE INDEX idx_planning_project_created ON planning_requests(project_id, created_at DESC);

CREATE TABLE planning_request_nodes (
  planning_request_id TEXT NOT NULL REFERENCES planning_requests(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES timeline_nodes(id) ON DELETE CASCADE,
  PRIMARY KEY(planning_request_id, node_id)
);
