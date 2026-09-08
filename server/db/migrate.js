import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTransaction } from './database.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = path.join(moduleDir, 'migrations');

function upgradeLegacyProjects(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name)
  );
  const additions = [
    ['base_branch', "TEXT NOT NULL DEFAULT 'main'"],
    ['production_branch', 'TEXT'],
    ['stable_branch', 'TEXT'],
    ['protected_branches_json', "TEXT NOT NULL DEFAULT '[\"main\"]'"],
    ['interaction_level', "TEXT NOT NULL DEFAULT 'assist'"],
    ['provider_kind', "TEXT NOT NULL DEFAULT 'claude'"],
    ['provider_config_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['last_sequence', 'INTEGER NOT NULL DEFAULT 0'],
    ['updated_at', "TEXT NOT NULL DEFAULT ''"]
  ];

  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
  }

  db.exec(`
    UPDATE projects
    SET updated_at = COALESCE(NULLIF(updated_at, ''), created_at, datetime('now'))
  `);
}

export function migrate(db, migrationsDir = defaultMigrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version)
  );
  const migrations = fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  for (const name of migrations) {
    const version = Number(name.match(/^\d+/)[0]);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    withTransaction(db, () => {
      db.exec(sql);
      if (version === 1) upgradeLegacyProjects(db);
      db.prepare('INSERT INTO schema_migrations(version, name) VALUES (?, ?)').run(version, name);
    });
  }

  return db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
}
