import { emptyState, escapeHtml } from './components.js';

function runRow(run) {
  return `
    <article class="session-row" data-run-id="${escapeHtml(run.id)}">
      <span class="status-dot ${escapeHtml(run.status)}"></span>
      <div>
        <strong>${escapeHtml(run.nodeKey ? `${run.nodeKey} · ${run.nodeTitle}` : run.providerKind)}</strong>
        <p>${escapeHtml(run.branch)} · ${escapeHtml(run.providerKind)} · started ${escapeHtml(run.startedAt || '')}${run.finishedAt ? ` · finished ${escapeHtml(run.finishedAt)}` : ''}</p>
        <button class="button" data-toggle-output="${escapeHtml(run.id)}">Show output</button>
        <pre class="agent-stream" hidden aria-label="Run output">${escapeHtml(run.output || 'No output recorded.')}</pre>
      </div>
      <span class="badge">${escapeHtml(run.status)}</span>
    </article>`;
}

export async function initActivity(container, { project, api }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading local project signal…</div>';
  try {
    const feed = await api.getActivityFeed(project.id);
    const { runs = [] } = feed;
    container.innerHTML = `
      <article class="panel agent-workspace">
        <div class="panel-header"><div><p class="eyebrow">History</p><h2>Timeline-driven runs</h2></div></div>
        <div class="panel-body">${runs.length ? runs.map(runRow).join('') : emptyState('AC', 'No runs yet', 'Runs started from the timeline will appear here with their goal, status, and output.')}</div>
      </article>`;

    container.querySelectorAll('[data-toggle-output]').forEach((button) => button.addEventListener('click', (event) => {
      const pre = event.currentTarget.nextElementSibling;
      const hidden = pre.hasAttribute('hidden');
      if (hidden) pre.removeAttribute('hidden'); else pre.setAttribute('hidden', '');
      event.currentTarget.textContent = hidden ? 'Hide output' : 'Show output';
    }));
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Activity unavailable', error.message)}</div>`;
  }
}
