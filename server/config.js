import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_DOTENV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

function integer(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env = process.env, { dotenvPath = DEFAULT_DOTENV } = {}) {
  loadEnvFromDotenv(dotenvPath, env);
  const host = env.HOST || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host) && env.ALLOW_REMOTE_BIND !== 'true') {
    throw new Error('Non-loopback HOST requires ALLOW_REMOTE_BIND=true');
  }

  const dataDir = path.resolve(env.GATE_DATA_DIR || path.join(process.cwd(), 'data'));

  return Object.freeze({
    host,
    port: integer(env.PORT, 4177, 'PORT'),
    dataDir,
    databaseFile: path.join(dataDir, 'tracker.db'),
    validationDir: path.join(dataDir, 'tests'),
    worktreeDir: path.join(dataDir, 'worktrees'),
    jsonLimit: env.GATE_JSON_LIMIT || '1mb',
    outputLimitBytes: integer(env.GATE_OUTPUT_LIMIT_BYTES, 2_000_000, 'GATE_OUTPUT_LIMIT_BYTES'),
    allowRemoteBind: env.ALLOW_REMOTE_BIND === 'true',
    githubToken: env.GATE_GITHUB_TOKEN || '',
    githubApiUrl: env.GATE_GITHUB_API_URL || 'https://api.github.com'
  });
}

const DOTENV_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

export function loadEnvFromDotenv(filename = '.env', env = process.env) {
  let contents;
  try {
    contents = fs.readFileSync(filename, 'utf8');
  } catch {
    return env;
  }
  for (const line of contents.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const match = DOTENV_LINE.exec(line);
    if (!match) continue;
    const key = match[1];
    const raw = match[2].trim();
    const value = raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"'
      ? raw.slice(1, -1)
      : raw;
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}
