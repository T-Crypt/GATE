import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';

function prepareTarget(targetPath) {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (fs.existsSync(resolved)) throw new Error(`Backup target already exists: ${resolved}`);
  return resolved;
}

function checksum(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

export class BackupService {
  constructor(db) {
    this.db = db;
  }

  async create(targetPath) {
    const destination = prepareTarget(targetPath);
    await backup(this.db, destination);
    return { path: destination, sha256: checksum(destination), createdAt: new Date().toISOString() };
  }

  exportJson(targetPath) {
    const destination = prepareTarget(targetPath);
    const tables = ['projects', 'events', 'timeline_nodes', 'timeline_edges', 'gates', 'evidence', 'approvals', 'runs', 'issues', 'notes', 'tags', 'note_tags', 'git_events'];
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      data: Object.fromEntries(tables.map((table) => [table, this.db.prepare(`SELECT * FROM ${table}`).all()]))
    };
    fs.writeFileSync(destination, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { path: destination, sha256: checksum(destination), createdAt: payload.exportedAt };
  }
}
