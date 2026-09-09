import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 10_000;
const EXCLUDED_DIRECTORIES = new Set(['.git', '.gate', 'node_modules', 'dist', 'build', 'coverage', '.next', 'vendor']);

function slash(value) {
  return value.split(path.sep).join('/');
}

function nodeId(projectId, type, relativePath) {
  return `memory:${projectId}:${type}:${encodeURIComponent(relativePath || 'root')}`;
}

function edgeId(projectId, sourceNodeId, targetNodeId) {
  return `memory:${projectId}:contains:${createHash('sha256').update(`${sourceNodeId}:${targetNodeId}`).digest('hex').slice(0, 24)}`;
}

function fileHash(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gateIgnore(root) {
  const target = path.join(root, '.gateignore');
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, 'utf8').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function matchesIgnore(relativePath, patterns) {
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/\\/g, '/');
    if (normalized.endsWith('/')) return relativePath === normalized.slice(0, -1) || relativePath.startsWith(normalized);
    const expression = `^${normalized.split('*').map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('[^/]*')}$`;
    return new RegExp(expression).test(relativePath);
  });
}

function secretPath(relativePath) {
  const name = path.basename(relativePath).toLowerCase();
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.pem') || name.endsWith('.key') ||
    name.startsWith('credentials') || name.startsWith('secrets');
}

function isExcluded(relativePath, directory, patterns) {
  const parts = relativePath.split('/');
  return (directory && EXCLUDED_DIRECTORIES.has(parts.at(-1))) || secretPath(relativePath) || matchesIgnore(relativePath, patterns);
}

function parentPath(relativePath) {
  const parent = path.posix.dirname(relativePath);
  return parent === '.' ? '' : parent;
}

export class MemoryIndexService {
  collect(root, { paths = null } = {}) {
    const patterns = gateIgnore(root);
    const records = new Map();
    const add = (relativePath) => {
      const normalized = slash(relativePath).replace(/^\.\//, '');
      if (!normalized || isExcluded(normalized, false, patterns)) return;
      const target = path.join(root, normalized);
      if (!fs.existsSync(target)) return;
      const entry = fs.statSync(target);
      if (entry.isDirectory()) {
        if (isExcluded(normalized, true, patterns)) return;
        records.set(normalized, { type: 'directory', path: normalized, name: path.posix.basename(normalized) });
        for (const child of fs.readdirSync(target)) add(path.posix.join(normalized, child));
        return;
      }
      if (!entry.isFile() || entry.size > MAX_FILE_BYTES || isExcluded(normalized, false, patterns)) return;
      const sample = fs.readFileSync(target, { encoding: null, flag: 'r' }).subarray(0, 4096);
      if (sample.includes(0)) return;
      records.set(normalized, {
        type: 'file',
        path: normalized,
        name: path.posix.basename(normalized),
        contentHash: fileHash(target),
        metadata: {
          size: entry.size,
          extension: path.extname(normalized).toLowerCase(),
          isTest: /(^|[./_-])(test|spec)([./_-]|$)/i.test(normalized)
        }
      });
    };

    if (paths) {
      for (const relativePath of paths) {
        add(relativePath);
        let ancestor = parentPath(slash(relativePath));
        while (ancestor) {
          add(ancestor);
          ancestor = parentPath(ancestor);
        }
      }
    } else {
      for (const child of fs.readdirSync(root)) add(child);
    }
    if (records.size > MAX_FILES) throw new Error(`Memory indexing limit of ${MAX_FILES} files exceeded`);
    return records;
  }

  replace(db, { projectId, root, repositorySha, mode, changedPaths = [] }) {
    const isFull = mode === 'full';
    const records = this.collect(root, { paths: isFull ? null : changedPaths });
    const rootId = nodeId(projectId, 'repository', '');
    const provenance = JSON.stringify({ origin: 'filesystem', repositorySha });

    if (isFull) {
      db.prepare('DELETE FROM memory_edges WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM memory_nodes WHERE project_id = ?').run(projectId);
    } else {
      for (const relativePath of changedPaths) {
        db.prepare('DELETE FROM memory_nodes WHERE project_id = ? AND path = ?').run(projectId, slash(relativePath));
      }
    }

    db.prepare(
      `INSERT INTO memory_nodes(id, project_id, node_type, path, name, content_hash, metadata_json, provenance_json, indexed_sha, updated_at)
       VALUES (?, ?, 'repository', '', ?, NULL, '{}', ?, ?, datetime('now'))
       ON CONFLICT(project_id, node_type, path) DO UPDATE SET indexed_sha = excluded.indexed_sha, updated_at = excluded.updated_at`
    ).run(rootId, projectId, path.basename(root), provenance, repositorySha);

    const orderedRecords = [...records.values()].sort((left, right) => {
      const depth = left.path.split('/').length - right.path.split('/').length;
      if (depth !== 0) return depth;
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
    for (const record of orderedRecords) {
      const id = nodeId(projectId, record.type, record.path);
      db.prepare(
        `INSERT INTO memory_nodes(id, project_id, node_type, path, name, content_hash, metadata_json, provenance_json, indexed_sha, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(project_id, node_type, path) DO UPDATE SET
           name = excluded.name, content_hash = excluded.content_hash, metadata_json = excluded.metadata_json,
           provenance_json = excluded.provenance_json, indexed_sha = excluded.indexed_sha, updated_at = excluded.updated_at`
      ).run(id, projectId, record.type, record.path, record.name, record.contentHash || null, JSON.stringify(record.metadata || {}), provenance, repositorySha);
      const parent = parentPath(record.path);
      const parentId = parent ? nodeId(projectId, 'directory', parent) : rootId;
      db.prepare(
        `INSERT INTO memory_edges(id, project_id, source_node_id, target_node_id, edge_type, provenance_json, indexed_sha, updated_at)
         VALUES (?, ?, ?, ?, 'CONTAINS', ?, ?, datetime('now'))
         ON CONFLICT(project_id, source_node_id, target_node_id, edge_type) DO UPDATE SET
           provenance_json = excluded.provenance_json, indexed_sha = excluded.indexed_sha, updated_at = excluded.updated_at`
      ).run(edgeId(projectId, parentId, id), projectId, parentId, id, provenance, repositorySha);
    }

    const counts = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ? AND node_type = 'file') AS files,
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ?) AS nodes,
         (SELECT COUNT(*) FROM memory_edges WHERE project_id = ?) AS edges`
    ).get(projectId, projectId, projectId);
    return { ...counts, indexedPaths: [...records.keys()] };
  }
}
