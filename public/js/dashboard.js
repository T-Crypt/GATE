import { emptyState, escapeHtml, showToast } from './components.js';

function metric(label, value, tone = '') {
  return `<article class="panel metric ${tone}"><span class="metric-label">${escapeHtml(label)}</span><strong class="metric-value">${escapeHtml(value)}</strong></article>`;
}

export async function initDashboard(container, { project, api, focus = 'overview' }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading local project signal…</div>';
  try {
    const model = await api.getDashboard(project.id);
    const { metrics = {}, issues = [], notes = [], gitEvents = [] } = model;
    container.innerHTML = `
      <div class="placeholder-grid dashboard-metrics">
        ${metric('Active runs', metrics.activeRuns || 0, 'cyan')}
        ${metric('Blocked gates', metrics.blockedGates || 0, metrics.blockedGates ? 'amber' : '')}
        ${metric('Review queue', metrics.reviewQueue || 0, metrics.reviewQueue ? 'violet' : '')}
        ${metric('Open issues', metrics.openIssues || 0)}
      </div>
      <div class="operations-grid">
        <article class="panel" id="issuesPanel">
          <div class="panel-header"><div><p class="eyebrow">Local tracker</p><h2>Issues</h2></div></div>
          <div class="panel-body"><form class="inline-form" id="issueForm"><label class="sr-only" for="issueTitle">New issue</label><input id="issueTitle" placeholder="Capture a local work item" maxlength="500" required><button class="button primary">Add issue</button></form><div class="record-list">${issues.length ? issues.map((issue) => `<div class="record-row"><span class="status-dot ${escapeHtml(issue.status)}"></span><strong>${escapeHtml(issue.title)}</strong><label class="sr-only" for="issue-${issue.id}">Issue status</label><select id="issue-${issue.id}" class="compact-select issue-status" data-id="${issue.id}"><option value="open" ${issue.status === 'open' ? 'selected' : ''}>open</option><option value="in_progress" ${issue.status === 'in_progress' ? 'selected' : ''}>in progress</option><option value="closed" ${issue.status === 'closed' ? 'selected' : ''}>closed</option></select></div>`).join('') : emptyState('IS', 'No open issues', 'Capture decisions and small follow-up work without leaving the workstation.')}</div></div>
        </article>
        <article class="panel" id="gitPanel">
          <div class="panel-header"><div><p class="eyebrow">Observed only</p><h2>Git activity</h2></div><button class="button" id="syncGit">Sync ${escapeHtml(project.baseBranch)}</button></div>
          <div class="panel-body record-list">${gitEvents.length ? gitEvents.slice(0, 12).map((commit) => `<div class="commit-row"><code>${escapeHtml(commit.commit_hash.slice(0, 8))}</code><div><strong>${escapeHtml(commit.message)}</strong><p>${escapeHtml(commit.author || 'unknown')} · ${escapeHtml(commit.committed_at || '')}</p></div></div>`).join('') : emptyState('GT', 'No cached commits', 'Sync reads local Git history. It never pushes or changes a branch.')}</div>
        </article>
        <article class="panel notes-panel">
          <div class="panel-header"><div><p class="eyebrow">Project memory</p><h2>Notes</h2></div></div>
          <div class="panel-body"><form class="form-grid" id="noteForm"><label class="sr-only" for="noteBody">New note</label><textarea id="noteBody" placeholder="Record an architectural decision or review note" required></textarea><label class="sr-only" for="noteTags">Tags</label><input id="noteTags" placeholder="tags, separated, by commas"><button class="button primary">Save local note</button></form><div class="record-list note-list">${notes.length ? notes.map((note) => `<div class="note-row"><p>${escapeHtml(note.body)}</p><div>${note.tags.map((tag) => `<span class="badge">${escapeHtml(tag.name)}</span>`).join('')}</div></div>`).join('') : '<p class="muted-copy">No notes yet.</p>'}</div></div>
        </article>
      </div>`;

    container.querySelector('#issueForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const title = event.currentTarget.querySelector('#issueTitle').value.trim();
      if (!title) return;
      await api.addIssue(project.id, { title });
      showToast('Issue saved locally');
      await initDashboard(container, { project, api, focus });
    });
    container.querySelectorAll('.issue-status').forEach((select) => select.addEventListener('change', async () => {
      await api.updateIssue(project.id, select.dataset.id, { status: select.value });
      showToast('Issue status updated');
    }));
    container.querySelector('#syncGit')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      await api.syncGit(project.id);
      showToast('Local Git history refreshed');
      await initDashboard(container, { project, api, focus });
    });
    container.querySelector('#noteForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const body = form.querySelector('#noteBody').value.trim();
      const tags = form.querySelector('#noteTags').value.split(',').map((tag) => tag.trim()).filter(Boolean);
      await api.addNote(project.id, { body, tags });
      showToast('Note saved locally');
      await initDashboard(container, { project, api, focus });
    });
    if (focus === 'issues') container.querySelector('#issuesPanel')?.scrollIntoView();
    if (focus === 'git') container.querySelector('#gitPanel')?.scrollIntoView();
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Dashboard unavailable', error.message)}</div>`;
  }
}
