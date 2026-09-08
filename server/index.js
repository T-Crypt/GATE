import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import dashboardRoutes from './routes/dashboard.js';
import agentRoutes from './routes/agent.js';
import timelineRoutes from './routes/timeline.js';
import { attachSubscriber, detachSubscriber } from './agent/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', dashboardRoutes);
app.use('/api', agentRoutes);
app.use('/api', timelineRoutes);

const server = http.createServer(app);

// WS protocol: client sends { type: 'subscribe', sessionId } to attach to a live
// agent session's output stream. Server pushes { type: 'agent_output' | 'agent_closed', ... }.
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const subscribedSessions = new Set();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'subscribe' && msg.sessionId) {
      attachSubscriber(msg.sessionId, ws);
      subscribedSessions.add(msg.sessionId);
    }
    if (msg.type === 'unsubscribe' && msg.sessionId) {
      detachSubscriber(msg.sessionId, ws);
      subscribedSessions.delete(msg.sessionId);
    }
  });

  ws.on('close', () => {
    for (const sessionId of subscribedSessions) detachSubscriber(sessionId, ws);
  });
});

const PORT = process.env.PORT || 4177;
server.listen(PORT, () => {
  console.log(`project-tracker running on http://localhost:${PORT}`);
});
