import { emptyState, escapeHtml, showToast } from './components.js';

const COLUMNS = [
  ['open', 'Open'],
  ['in_progress', 'In progress'],
  ['closed', 'Closed']
];

function issueCard(issue) {
  return `
    <div class="issue-card" data-id="${issue.id}">
      <strong>${escapeHtml(issue.title)}</strong>
      <div class="issue-card-foot">
        <label class="sr-only" for="issue-${issue.id}">Issue status</label>
        <select id="issue-${issue.id}" class="compact-select issue-status" data-id="${issue.id}">
          ${COLUMNS.map(([value, label]) => `<option value="${value}" ${issue.status === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
      </div>
    </div>`;
}

function board(issues) {
  return `
    <div class="issues-board">
      ${COLUMNS.map(([status, label]) => {
        const inColumn = issues.filter((issue) => issue.status === status);
        return `
          <div class="issues-column">
            <div class="issues-column-head"><span>${escapeHtml(label)}</span><span>${inColumn.length}</span></div>
            <div class="issues-column-body">${inColumn.length ? inColumn.map(issueCard).join('') : '<p class="muted-copy">Nothing here.</p>'}</div>
          </div>`;
      }).join('')}
    </div>`;
}

export async function initIssues(container, { project, api }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading local project signal…</div>';
  try {
    const model = await api.getDashboard(project.id);
    const { issues = [], notes = [] } = model;
    container.innerHTML = `
      <article class="panel" id="issuesPanel">
        <div class="panel-header"><div><p class="eyebrow">Local tracker</p><h2>Issues</h2></div></div>
        <div class="panel-body">
          <form class="inline-form" id="issueForm">
            <label class="sr-only" for="issueTitle">New issue</label>
            <input id="issueTitle" placeholder="Capture a local work item" maxlength="500" required>
            <button class="button primary">Add issue</button>
          </form>
          ${issues.length ? board(issues) : emptyState('IS', 'No open issues', 'Capture decisions and small follow-up work without leaving the workstation.')}
        </div>
      </article>
      <article class="panel notes-panel" id="notesPanel">
        <div class="panel-header"><div><p class="eyebrow">Project memory</p><h2>Notes</h2></div></div>
        <div class="panel-body">
          <form class="form-grid" id="noteForm">
            <label class="sr-only" for="noteBody">New note</label>
            <textarea id="noteBody" placeholder="Record an architectural decision or review note" required></textarea>
            <label class="sr-only" for="noteTags">Tags</label>
            <input id="noteTags" placeholder="tags, separated, by commas">
            <button class="button primary">Save local note</button>
          </form>
          <div class="record-list note-list">${notes.length ? notes.map((note) => `<div class="note-row"><p>${escapeHtml(note.body)}</p><div>${note.tags.map((tag) => `<span class="badge">${escapeHtml(tag.name)}</span>`).join('')}</div></div>`).join('') : '<p class="muted-copy">No notes yet.</p>'}</div>
        </div>
      </article>`;

    container.querySelector('#issueForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const title = event.currentTarget.querySelector('#issueTitle').value.trim();
      if (!title) return;
      await api.addIssue(project.id, { title });
      showToast('Issue saved locally');
      await initIssues(container, { project, api });
    });
    container.querySelectorAll('.issue-status').forEach((select) => select.addEventListener('change', async () => {
      await api.updateIssue(project.id, select.dataset.id, { status: select.value });
      showToast('Issue status updated');
      await initIssues(container, { project, api });
    }));
    container.querySelector('#noteForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const body = form.querySelector('#noteBody').value.trim();
      const tags = form.querySelector('#noteTags').value.split(',').map((tag) => tag.trim()).filter(Boolean);
      await api.addNote(project.id, { body, tags });
      showToast('Note saved locally');
      await initIssues(container, { project, api });
    });
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Issues unavailable', error.message)}</div>`;
  }
}
