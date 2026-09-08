export async function initTimeline(projectId) {
  const panel = document.getElementById('tab-timeline');
  panel.innerHTML = `
    <div class="card">
      <h3>Milestones <button class="ghost" id="addMilestoneBtn" style="float:right;padding:2px 10px;">+ Add</button></h3>
      <div class="timeline-track" id="track"></div>
    </div>
    <div id="modalRoot"></div>
  `;

  async function loadMilestones() {
    const milestones = await (await fetch(`/api/projects/${projectId}/milestones`)).json();
    const track = document.getElementById('track');
    track.innerHTML = milestones.length
      ? milestones.map(m => `
        <div class="milestone-tile" data-id="${m.id}" style="border-color:${m.color};background:${m.color}22;">
          <div class="m-title">${escapeHtml(m.title)}</div>
          <div class="m-status">${m.status} · ${m.steps.length} step(s)</div>
        </div>`).join('')
      : `<div class="muted">No milestones yet. This is where the AI-predicted plan would land once the drafting flow is built — for now, add them manually.</div>`;

    track.querySelectorAll('.milestone-tile').forEach(tile => {
      tile.addEventListener('click', () => openMilestone(Number(tile.dataset.id), milestones));
    });
  }

  document.getElementById('addMilestoneBtn').addEventListener('click', async () => {
    const title = prompt('Milestone title:');
    if (!title) return;
    const color = prompt('Color (hex):', '#4f8cff');
    await fetch(`/api/projects/${projectId}/milestones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, color })
    });
    loadMilestones();
  });

  function openMilestone(id, milestones) {
    const m = milestones.find(x => x.id === id);
    const modalRoot = document.getElementById('modalRoot');
    modalRoot.innerHTML = `
      <div class="modal-backdrop" id="backdrop">
        <div class="modal">
          <h3 style="margin-top:0;">${escapeHtml(m.title)}
            <span class="badge ${m.status}" style="margin-left:8px;">${m.status}</span>
          </h3>
          <div class="muted" style="margin-bottom:10px;">${escapeHtml(m.goal_note || 'No goal note.')}</div>

          <div style="display:flex;gap:8px;margin-bottom:10px;">
            <select id="statusSelect">
              <option value="draft" ${m.status === 'draft' ? 'selected' : ''}>draft</option>
              <option value="locked" ${m.status === 'locked' ? 'selected' : ''}>locked</option>
              <option value="in_progress" ${m.status === 'in_progress' ? 'selected' : ''}>in_progress</option>
              <option value="done" ${m.status === 'done' ? 'selected' : ''}>done</option>
            </select>
          </div>

          <h4 style="margin-bottom:6px;">Prompt Steps</h4>
          <div class="step-grid" id="stepGrid">
            ${m.steps.map((s, i) => `
              <div class="step-cell">
                <span class="num">#${i + 1}</span>
                <span class="badge ${s.status}">${s.status}</span>
                <div style="margin-top:6px;">${escapeHtml(s.prompt_text)}</div>
              </div>`).join('') || `<div class="muted">No steps yet.</div>`}
          </div>

          <div style="display:flex;gap:8px;margin-top:12px;">
            <input type="text" id="newStepInput" placeholder="New prompt step..." />
            <button class="primary" id="addStepBtn">Add</button>
          </div>

          <div style="margin-top:16px;text-align:right;">
            <button class="ghost" id="closeModalBtn">Close</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('closeModalBtn').addEventListener('click', () => modalRoot.innerHTML = '');
    document.getElementById('backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'backdrop') modalRoot.innerHTML = '';
    });

    document.getElementById('statusSelect').addEventListener('change', async (e) => {
      await fetch(`/api/milestones/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: e.target.value })
      });
      loadMilestones();
    });

    document.getElementById('addStepBtn').addEventListener('click', async () => {
      const input = document.getElementById('newStepInput');
      if (!input.value.trim()) return;
      await fetch(`/api/milestones/${id}/steps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_text: input.value.trim() })
      });
      modalRoot.innerHTML = '';
      await loadMilestones();
    });
  }

  loadMilestones();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}
