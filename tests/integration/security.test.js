import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';

import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { createTestDatabase } from '../helpers/database.js';

test('non-loopback bind requires explicit opt-in', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /ALLOW_REMOTE_BIND/);
  assert.equal(loadConfig({ HOST: '0.0.0.0', ALLOW_REMOTE_BIND: 'true' }).allowRemoteBind, true);
});

test('malformed JSON still receives a request id and hardened headers', async () => {
  const database = createTestDatabase();
  try {
    const services = { events: { db: database.db } };
    const app = createApp({ services, config: { jsonLimit: '20kb' }, routes: false });
    const response = await request(app).post('/api/v1/projects').set('Content-Type', 'application/json').send('{');
    assert.equal(response.status, 400);
    assert.ok(response.headers['x-request-id']);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  } finally {
    database.close();
  }
});
