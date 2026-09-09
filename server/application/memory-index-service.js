import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LanguageIndexerRegistry } from '../adapters/language-indexers/registry.js';

const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 10_000;
const EXCLUDED_DIRECTORIES = new Set(['.git', '.gate', 'node_modules', 'dist', 'build', 'coverage', '.next', 'vendor']);
const MODULE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json'];

function slash(value) {
  return value.split(path.sep).join('/');
}

function nodeId(projectId, type, identity) {
  return `memory:${projectId}:${type}:${encodeURIComponent(identity || 'root')}`;
}

function edgeId(projectId, type, sourceNodeId, targetNodeId) {
  const digest = createHash('sha256').update(`${type}:${sourceNodeId}:${targetNodeId}`).digest('hex').slice(0, 24);
  return `memory:${projectId}:${type.toLowerCase()}:${digest}`;
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

function symbolPath(sourcePath, symbol) {
  return `${sourcePath}#${symbol.kind}:${encodeURIComponent(symbol.name)}:${symbol.line}`;
}

function resolveImport(sourcePath, specifier, knownFiles) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const extension = path.posix.extname(base);
  const candidates = extension
    ? [base]
    : [base, ...MODULE_EXTENSIONS.map((candidate) => `${base}${candidate}`), ...MODULE_EXTENSIONS.map((candidate) => `${base}/index${candidate}`)];
  return candidates.find((candidate) => knownFiles.has(candidate)) || null;
}

function insertEdge(db, { projectId, type, sourceNodeId, targetNodeId, provenance, repositorySha }) {
  db.prepare(
    `INSERT INTO memory_edges(id, project_id, source_node_id, target_node_id, edge_type, provenance_json, indexed_sha, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project_id, source_node_id, target_node_id, edge_type) DO UPDATE SET
       provenance_json = excluded.provenance_json, indexed_sha = excluded.indexed_sha, updated_at = excluded.updated_at`
  ).run(
    edgeId(projectId, type, sourceNodeId, targetNodeId),
    projectId,
    sourceNodeId,
    targetNodeId,
    type,
    JSON.stringify(provenance),
    repositorySha
  );
}

export class MemoryIndexService {
  constructor({ languageIndexers = new LanguageIndexerRegistry() } = {}) {
    this.languageIndexers = languageIndexers;
  }

  collect(root, { paths = null } = {}) {
    const patterns = gateIgnore(root);
    const records = new Map();
    const add = (relativePath, recursive = true) => {
      const normalized = slash(relativePath).replace(/^\.\//, '');
      if (!normalized || isExcluded(normalized, false, patterns)) return;
      const target = path.join(root, normalized);
      if (!fs.existsSync(target)) return;
      const entry = fs.statSync(target);
      if (entry.isDirectory()) {
        if (isExcluded(normalized, true, patterns)) return;
        records.set(normalized, { type: 'directory', path: normalized, name: path.posix.basename(normalized) });
        if (recursive) {
          for (const child of fs.readdirSync(target)) add(path.posix.join(normalized, child));
        }
        return;
      }
      if (!entry.isFile() || entry.size > MAX_FILE_BYTES || isExcluded(normalized, false, patterns)) return;
      const buffer = fs.readFileSync(target);
      if (buffer.subarray(0, 4096).includes(0)) return;
      const analysis = this.languageIndexers.parse({ path: normalized, content: buffer.toString('utf8') });
      records.set(normalized, {
        type: 'file',
        path: normalized,
        name: path.posix.basename(normalized),
        contentHash: createHash('sha256').update(buffer).digest('hex'),
        analysis,
        metadata: {
          size: entry.size,
          extension: path.extname(normalized).toLowerCase(),
          isTest: /(^|[./_-])(test|spec)([./_-]|$)/i.test(normalized),
          language: analysis.language
        }
      });
    };

    if (paths) {
      for (const relativePath of paths) {
        add(relativePath, false);
        let ancestor = parentPath(slash(relativePath));
        while (ancestor) {
          add(ancestor, false);
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
    const filesystemProvenance = { origin: 'filesystem', repositorySha };

    if (isFull) {
      db.prepare('DELETE FROM memory_edges WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM memory_nodes WHERE project_id = ?').run(projectId);
    } else {
      for (const relativePath of changedPaths.map(slash)) {
        const fileId = nodeId(projectId, 'file', relativePath);
        db.prepare("DELETE FROM memory_edges WHERE project_id = ? AND source_node_id = ? AND edge_type IN ('IMPORTS', 'REFERENCES')")
          .run(projectId, fileId);
        db.prepare("DELETE FROM memory_nodes WHERE project_id = ? AND source_path = ? AND node_type = 'symbol'")
          .run(projectId, relativePath);
        if (!fs.existsSync(path.join(root, relativePath))) {
          db.prepare("DELETE FROM memory_nodes WHERE project_id = ? AND path = ? AND node_type = 'file'").run(projectId, relativePath);
        }
      }
    }

    db.prepare(
      `INSERT INTO memory_nodes(id, project_id, node_type, path, source_path, name, content_hash, metadata_json, provenance_json, indexed_sha, updated_at)
       VALUES (?, ?, 'repository', '', '', ?, NULL, '{}', ?, ?, datetime('now'))
       ON CONFLICT(project_id, node_type, path) DO UPDATE SET indexed_sha = excluded.indexed_sha, updated_at = excluded.updated_at`
    ).run(rootId, projectId, path.basename(root), JSON.stringify(filesystemProvenance), repositorySha);

    const orderedRecords = [...records.values()].sort((left, right) => {
      const depth = left.path.split('/').length - right.path.split('/').length;
      if (depth !== 0) return depth;
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
    for (const record of orderedRecords) {
      const id = nodeId(projectId, record.type, record.path);
      db.prepare(
        `INSERT INTO memory_nodes(id, project_id, node_type, path, source_path, name, content_hash, metadata_json, provenance_json, indexed_sha, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(project_id, node_type, path) DO UPDATE SET
           source_path = excluded.source_path, name = excluded.name, content_hash = excluded.content_hash,
           metadata_json = excluded.metadata_json, provenance_json = excluded.provenance_json,
           indexed_sha = excluded.indexed_sha, updated_at = excluded.updated_at`
      ).run(
        id, projectId, record.type, record.path, record.path, record.name, record.contentHash || null,
        JSON.stringify(record.metadata || {}), JSON.stringify(filesystemProvenance), repositorySha
      );
      const parent = parentPath(record.path);
      const parentId = parent ? nodeId(projectId, 'directory', parent) : rootId;
      insertEdge(db, {
        projectId,
        type: 'CONTAINS',
        sourceNodeId: parentId,
        targetNodeId: id,
        provenance: filesystemProvenance,
        repositorySha
      });

      if (record.type === 'file') {
        for (const symbol of record.analysis.symbols) {
          const identity = symbolPath(record.path, symbol);
          const symbolId = nodeId(projectId, 'symbol', identity);
          const provenance = { origin: 'static_parser', repositorySha, sourcePath: record.path, line: symbol.line };
          db.prepare(
            `INSERT INTO memory_nodes(id, project_id, node_type, path, source_path, name, content_hash, metadata_json, provenance_json, indexed_sha, updated_at)
             VALUES (?, ?, 'symbol', ?, ?, ?, NULL, ?, ?, ?, datetime('now'))
             ON CONFLICT(project_id, node_type, path) DO UPDATE SET
               source_path = excluded.source_path, name = excluded.name, metadata_json = excluded.metadata_json,
               provenance_json = excluded.provenance_json, indexed_sha = excluded.indexed_sha, updated_at = excluded.updated_at`
          ).run(
            symbolId,
            projectId,
            identity,
            record.path,
            symbol.name,
            JSON.stringify({ kind: symbol.kind, line: symbol.line, exported: symbol.exported, language: record.analysis.language }),
            JSON.stringify(provenance),
            repositorySha
          );
          insertEdge(db, {
            projectId,
            type: 'CONTAINS',
            sourceNodeId: id,
            targetNodeId: symbolId,
            provenance,
            repositorySha
          });
        }
      }
    }

    const knownFiles = new Set(
      db.prepare("SELECT path FROM memory_nodes WHERE project_id = ? AND node_type = 'file'").all(projectId).map((row) => row.path)
    );
    for (const record of orderedRecords.filter((candidate) => candidate.type === 'file')) {
      const sourceId = nodeId(projectId, 'file', record.path);
      for (const imported of record.analysis.imports) {
        const targetPath = resolveImport(record.path, imported.specifier, knownFiles);
        if (!targetPath) continue;
        const targetId = nodeId(projectId, 'file', targetPath);
        const provenance = {
          origin: 'static_parser',
          repositorySha,
          sourcePath: record.path,
          line: imported.line,
          specifier: imported.specifier
        };
        insertEdge(db, {
          projectId,
          type: 'IMPORTS',
          sourceNodeId: sourceId,
          targetNodeId: targetId,
          provenance,
          repositorySha
        });
        for (const binding of imported.names.filter((name) => !['default', '*'].includes(name.imported))) {
          const targetSymbols = db.prepare(
            `SELECT id FROM memory_nodes
             WHERE project_id = ? AND node_type = 'symbol' AND source_path = ? AND name = ?
               AND json_extract(metadata_json, '$.exported') = 1`
          ).all(projectId, targetPath, binding.imported);
          for (const targetSymbol of targetSymbols) {
            insertEdge(db, {
              projectId,
              type: 'REFERENCES',
              sourceNodeId: sourceId,
              targetNodeId: targetSymbol.id,
              provenance: { ...provenance, imported: binding.imported, local: binding.local },
              repositorySha
            });
          }
        }
      }
    }

    const counts = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ? AND node_type = 'file') AS files,
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ? AND node_type = 'symbol') AS symbols,
         (SELECT COUNT(*) FROM memory_nodes WHERE project_id = ?) AS nodes,
         (SELECT COUNT(*) FROM memory_edges WHERE project_id = ?) AS edges`
    ).get(projectId, projectId, projectId, projectId);
    return { ...counts, indexedPaths: [...records.keys()] };
  }
}
