import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';

import { createApp } from '../../server/app.js';
import { createHttpServer } from '../../server/adapters/live-events.js';
import { EventStore } from '../../server/application/event-store.js';
import { createTestDatabase } from '../helpers/database.js';

function eventInput(projectId, index) {
  return {
    projectId,
    type: 'system.test',
    actor: { type: 'system', id: 'test' },
    correlationId: `event-${index}`,
    payload: { index }
  };
}

test('a reconnect replays events after the client sequence and then streams live events', async () => {
  const database = createTestDatabase();
  database.db.prepare(`INSERT INTO projects(name, repo_path) VALUES ('Sample', '/tmp/sample')`).run();
  const events = new EventStore(database.db);
  for (let index = 1; index <= 4; index += 1) events.append(eventInput(1, index));
  const app = createApp({
    services: { events },
    config: { jsonLimit: '20kb' },
    routes: false
  });
  const server = createHttpServer({ app, eventStore: events, heartbeatMs: 1000 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?projectId=1&after=2`);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

  try {
    await once(socket, 'open');
    while (messages.filter((message) => message.type === 'event').length < 2) {
      await once(socket, 'message');
    }
    assert.deepEqual(
      messages.filter((message) => message.type === 'event').map((message) => message.sequence),
      [3, 4]
    );

    events.append(eventInput(1, 5));
    while (!messages.some((message) => message.type === 'event' && message.sequence === 5)) {
      await once(socket, 'message');
    }
    assert.ok(messages.some((message) => message.type === 'event' && message.sequence === 5));
  } finally {
    socket.close();
    server.close();
    database.close();
  }
});
