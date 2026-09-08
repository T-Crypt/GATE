let ws = null;
let currentSessionId = null;

export async function initAgent(projectId) {
  const panel = document.getElementById('tab-agent');
  panel.innerHTML = `
    <div class="card">
      <h3>Drive Agent Session</h3>
      <textarea id="promptInput" rows="4" placeholder="Prompt to send to the agent CLI for this project..."></textarea>
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button class="primary" id="runBtn">Run</button>
        <button class="ghost" id="killBtn" disabled>Kill</button>
        <span id="sessionStatus" class="muted" style="align-self:center;"></span>
      </div>
    </div>
    <div class="card">
      <h3>Live Output</h3>
      <div id="agent-log"></div>
    </div>
    <div class="card">
      <h3>Recent Sessions</h3>
      <div id="sessionHistory"></div>
    </div>
  `;

  const log = document.getElementById('agent-log');
  const statusEl = document.getElementById('sessionStatus');
  const killBtn = document.getElementById('killBtn');

  connectWs(log, statusEl, killBtn);

  document.getElementById('runBtn').addEventListener('click', async () => {
    const promptText = document.getElementById('promptInput').value.trim();
    if (!promptText) return;

    log.textContent = '';
    statusEl.textContent = 'starting...';
    killBtn.disabled = false;

    const res = await fetch(`/api/projects/${projectId}/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText })
    });
    const { sessionId } = await res.json();
    currentSessionId = sessionId;
    statusEl.textContent = `session #${sessionId} running`;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    }
    loadHistory(projectId);
  });

  killBtn.addEventListener('click', async () => {
    if (!currentSessionId) return;
    await fetch(`/api/agent/sessions/${currentSessionId}/kill`, { method: 'POST' });
    statusEl.textContent = 'killed';
    killBtn.disabled = true;
  });

  loadHistory(projectId);
}

function connectWs(log, statusEl, killBtn) {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'agent_output' && msg.sessionId === currentSessionId) {
      log.textContent += msg.chunk;
      log.scrollTop = log.scrollHeight;
    }
    if (msg.type === 'agent_closed' && msg.sessionId === currentSessionId) {
      statusEl.textContent = `session #${msg.sessionId} ${msg.status}`;
      killBtn.disabled = true;
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(() => connectWs(log, statusEl, killBtn), 1500);
  });
}

async function loadHistory(projectId) {
  const sessions = await (await fetch(`/api/projects/${projectId}/agent/sessions`)).json();
  const el = document.getElementById('sessionHistory');
  if (!el) return;
  el.innerHTML = sessions.length
    ? sessions.map(s => `
      <div class="list-row">
        <span class="badge ${s.status}">${s.status}</span>
        <span>${escapeHtml(s.prompt_text.slice(0, 80))}</span>
        <span class="muted" style="margin-left:auto;">${s.started_at}</span>
      </div>`).join('')
    : `<div class="muted">No sessions yet.</div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}
