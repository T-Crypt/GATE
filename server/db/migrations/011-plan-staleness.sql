-- Re-grounding never discards human-approved work: it proposes a new plan and
-- records which one it was grounded against. Staleness itself is computed live
-- from the plan's stored provenance, so no cached status column is needed.
ALTER TABLE planning_requests ADD COLUMN supersedes_id TEXT REFERENCES planning_requests(id);
CREATE INDEX idx_planning_supersedes ON planning_requests(supersedes_id);
