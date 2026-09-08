import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const DIRECTORIES = ['server', 'public/js', 'tests'];

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...collectJsFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const targets = [];
for (const dir of DIRECTORIES) {
  const root = join(process.cwd(), dir);
  let exists = true;
  try {
    statSync(root);
  } catch {
    exists = false;
  }
  if (!exists) {
    console.warn(`lint: skipping missing directory ${dir}`);
    continue;
  }
  targets.push(...collectJsFiles(root));
}

let failed = 0;
for (const file of targets) {
  // stdio 'inherit' so node --check prints its own error (including the file
  // path) directly; also keeps this working in restricted environments where
  // capturing child-process output is not allowed.
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0 || result.error) {
    failed += 1;
    console.error(`lint: ${file}${result.error ? ` (${result.error.code || result.error})` : ''}`);
  }
}

console.log(`lint: checked ${targets.length} files, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
