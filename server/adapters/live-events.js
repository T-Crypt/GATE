import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const MAX_BUFFERED_BYTES = 1_000_000;

function send(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.close(1013, 'client too slow');
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

export function createHttpServer({ app, eventStore, heartbeatMs = 15_000 }) {
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  sockets.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const projectId = Number(url.searchParams.get('projectId'));
    const after = Number(url.searchParams.get('after') || 0);
    if (!Number.isSafeInteger(projectId) || projectId < 1 || !Number.isSafeInteger(after) || after < 0) {
      socket.close(1008, 'invalid subscription');
      return;
    }

    let delivered = after;
    send(socket, { type: 'hello', protocolVersion: 1, projectId, afterSequence: after });
    for (const event of eventStore.readAfter(projectId, after, 1000)) {
      delivered = event.sequence;
      send(socket, { type: 'event', sequence: event.sequence, event });
    }
    const unsubscribe = eventStore.subscribe(projectId, (event) => {
      if (event.sequence <= delivered) return;
      delivered = event.sequence;
      send(socket, { type: 'event', sequence: event.sequence, event });
    });
    const heartbeat = setInterval(
      () => send(socket, { type: 'heartbeat', sequence: delivered, timestamp: new Date().toISOString() }),
      heartbeatMs
    );
    heartbeat.unref();
    socket.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return server;
}
