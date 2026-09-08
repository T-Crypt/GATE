export async function initDashboard(projectId) {
  const panel = document.getElementById('tab-dashboard');
  panel.innerHTML = `
    <div class="grid-cols">
      <div>
        <div class="card">
          <h3>Git Activity <button class="ghost" id="syncBtn" style="float:right;padding:2px 10px;">Sync</button></h3>
          <div id="gitList"></div>
        </div>
        <div class="card">
          <h3>Issues</h3>
          <div style="display:flex;gap:8px;margin-bottom:10px;">
            <input type="text" id="issueTitle" placeholder="New issue title" />
            <button class="primary" id="addIssueBtn">Add</button>
          </div>
          <div id="issueList"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Notes</h3>
          <textarea id="noteBody" rows="3" placeholder="Note (comma-separated tags after ::)  e.g. Fixed VPN cert renewal :: infra, aea"></textarea>
          <div style="margin-top:8px;"><button class="primary" id="addNoteBtn">Add note</button></div>
          <div id="noteList" style="margin-top:12px;"></div>
        </div>
      </div>
    </div>
  `;

  const gitList = document.getElementById('gitList');
  const issueList = document.getElementById('issueList');
  const noteList = document.getElementById('noteList');

  async function loadGit() {
    const events = await (await fetch(`/api/projects/${projectId}/git/events`)).json();
    gitList.innerHTML = events.length
      ? events.map(e => `
        <div class="list-row">
          <span class="hash">${e.commit_hash.slice(0, 7)}</span>
          <span>${escapeHtml(e.message)}</span>
          <span class="muted" style="margin-left:auto;">${e.author} · ${e.branch}</span>
        </div>`).join('')
      : `<div class="muted">No cached commits. Hit Sync.</div>`;
  }

  async function loadIssues() {
    const issues = await (await fetch(`/api/projects/${projectId}/issues`)).json();
    issueList.innerHTML = issues.length
      ? issues.map(i => `
        <div class="list-row">
          <span class="badge ${i.status}">${i.status}</span>
          <span>${escapeHtml(i.title)}</span>
          <select class="issue-status" data-id="${i.id}" style="margin-left:auto;font-size:11px;">
            <option value="open" ${i.status === 'open' ? 'selected' : ''}>open</option>
            <option value="in_progress" ${i.status === 'in_progress' ? 'selected' : ''}>in_progress</option>
            <option value="closed" ${i.status === 'closed' ? 'selected' : ''}>closed</option>
          </select>
        </div>`).join('')
      : `<div class="muted">No issues yet.</div>`;

    issueList.querySelectorAll('.issue-status').forEach(sel => {
      sel.addEventListener('change', async () => {
        await fetch(`/api/issues/${sel.dataset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: sel.value })
        });
        loadIssues();
      });
    });
  }

  async function loadNotes() {
    const notes = await (await fetch(`/api/projects/${projectId}/notes`)).json();
    noteList.innerHTML = notes.length
      ? notes.map(n => `
        <div class="list-row" style="flex-direction:column;align-items:flex-start;">
          <div>${escapeHtml(n.body)}</div>
          <div style="margin-top:4px;">${n.tags.map(t => `<span class="tag">${escapeHtml(t.name)}</span>`).join('')}
            <span class="muted" style="margin-left:6px;">${n.created_at}</span>
          </div>
        </div>`).join('')
      : `<div class="muted">No notes yet.</div>`;
  }

  document.getElementById('syncBtn').addEventListener('click', async () => {
    await fetch(`/api/projects/${projectId}/git/sync`, { method: 'POST' });
    loadGit();
  });

  document.getElementById('addIssueBtn').addEventListener('click', async () => {
    const input = document.getElementById('issueTitle');
    if (!input.value.trim()) return;
    await fetch(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: input.value.trim() })
    });
    input.value = '';
    loadIssues();
  });

  document.getElementById('addNoteBtn').addEventListener('click', async () => {
    const textarea = document.getElementById('noteBody');
    const raw = textarea.value.trim();
    if (!raw) return;
    const [body, tagPart] = raw.split('::');
    const tags = tagPart ? tagPart.split(',').map(t => t.trim()).filter(Boolean) : [];
    await fetch(`/api/projects/${projectId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: body.trim(), tags })
    });
    textarea.value = '';
    loadNotes();
  });

  loadGit();
  loadIssues();
  loadNotes();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}
