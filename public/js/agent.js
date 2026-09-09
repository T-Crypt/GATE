import { escapeHtml, providerName, showToast } from './components.js';

const activeStatuses = new Set(['starting', 'running']);

function runCard(run, timeline) {
  const node = timeline?.nodes?.find((candidate) => candidate.id === run.nodeId);
  return `<div class="rail-card run-card" data-run-id="${escapeHtml(run.id)}"><div class="run-heading"><span class="status-dot ${escapeHtml(run.status)}"></span><strong>${escapeHtml(node?.key || 'Run')} · ${escapeHtml(run.status)}</strong></div><p>${escapeHtml(node?.title || run.providerKind)}</p><div class="run-meta"><span>${escapeHtml(run.branch)}</span><span>${escapeHtml(run.providerKind)}</span></div><pre class="agent-stream" aria-label="Agent output">${escapeHtml(run.output || 'Waiting for provider output…')}</pre>${activeStatuses.has(run.status) ? `<button class="button danger cancel-run" data-cancel-run="${escapeHtml(run.id)}">Cancel run</button>` : ''}</div>`;
}

export async function renderActivityRail(container, { project, api }) {
  if (!container || !project) return;
  try {
    const [runs, timeline] = await Promise.all([api.getRuns(project.id), api.getTimeline(project.id)]);
    const active = runs.find((run) => activeStatuses.has(run.status));
    const recent = active || runs[0];
    container.innerHTML = recent ? `${runCard(recent, timeline)}<div class="rail-card"><strong>Safety boundary</strong><p>Working in ${escapeHtml(recent.worktreePath)}. ${escapeHtml(project.baseBranch)} remains protected.</p></div>` : `<div class="activity-empty">No agent run is active.</div><div class="rail-card"><strong>Safety boundary</strong><p>Runs branch from ${escapeHtml(project.baseBranch)} into an isolated worktree.</p></div>`;
    container.querySelector('[data-cancel-run]')?.addEventListener('click', async (event) => {
      try {
        await api.cancelRun(event.currentTarget.dataset.cancelRun);
        showToast('Run cancellation requested');
        await renderActivityRail(container, { project, api });
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  } catch (error) {
    container.innerHTML = `<div class="rail-card"><strong>Activity unavailable</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

export function appendLiveActivity(container, activity) {
  if (activity.kind !== 'agent.output') return;
  const card = container?.querySelector(`[data-run-id="${CSS.escape(activity.runId)}"]`);
  const stream = card?.querySelector('.agent-stream');
  if (!stream) return;
  if (stream.textContent === 'Waiting for provider output…') stream.textContent = '';
  stream.textContent += activity.chunk;
  stream.scrollTop = stream.scrollHeight;
}

export async function initAgent(container, context) {
  container.innerHTML = `<div class="panel agent-workspace"><div class="panel-header"><h2>${escapeHtml(providerName(context.project.providerKind))} execution sessions</h2></div><div class="panel-body" id="agentSessionList"></div></div>`;
  const list = container.querySelector('#agentSessionList');
  try {
    const runs = await context.api.getRuns(context.project.id);
    list.innerHTML = runs.length ? runs.map((run) => `<article class="session-row"><span class="status-dot ${escapeHtml(run.status)}"></span><div><strong>${escapeHtml(run.providerKind)}</strong><p>${escapeHtml(run.branch)}</p></div><span class="badge">${escapeHtml(run.status)}</span></article>`).join('') : '<p class="muted-copy">No provider sessions yet. Start a timeline step to create one.</p>';
  } catch (error) {
    list.innerHTML = `<p class="muted-copy">${escapeHtml(error.message)}</p>`;
  }
}
