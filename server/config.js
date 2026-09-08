import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function integer(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host) && env.ALLOW_REMOTE_BIND !== 'true') {
    throw new Error('Non-loopback HOST requires ALLOW_REMOTE_BIND=true');
  }

  const dataDir = path.resolve(env.PMCP_DATA_DIR || path.join(process.cwd(), 'data'));

  return Object.freeze({
    host,
    port: integer(env.PORT, 4177, 'PORT'),
    dataDir,
    databaseFile: path.join(dataDir, 'tracker.db'),
    validationDir: path.join(dataDir, 'tests'),
    worktreeDir: path.join(dataDir, 'worktrees'),
    jsonLimit: env.PMCP_JSON_LIMIT || '1mb',
    outputLimitBytes: integer(env.PMCP_OUTPUT_LIMIT_BYTES, 2_000_000, 'PMCP_OUTPUT_LIMIT_BYTES'),
    allowRemoteBind: env.ALLOW_REMOTE_BIND === 'true'
  });
}
