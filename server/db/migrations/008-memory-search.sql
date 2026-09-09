CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
  node_id UNINDEXED,
  project_id UNINDEXED,
  node_type UNINDEXED,
  name,
  path,
  content,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_search_node_delete
AFTER DELETE ON memory_nodes
BEGIN
  DELETE FROM memory_search WHERE node_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_search_project_delete
AFTER DELETE ON projects
BEGIN
  DELETE FROM memory_search WHERE project_id = old.id;
END;
