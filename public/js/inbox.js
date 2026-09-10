import { emptyState, escapeHtml, showToast } from './components.js';
import { stalenessBadge } from './features.js';

const KIND_LABEL = {
  plan_stale: 'Drifted plan',
  plan_proposed: 'Awaiting acceptance',
  run_failed: 'Failed run'
};

const ACTION_LABEL = {
  analyze: 'Analyze',
  reground: 'Re-ground plan',
  convert: 'Convert to issue',
  dismiss: 'Dismiss'
};

const ROUTE_LABEL = {
  features: 'Open feature',
  issues: 'Open issue',
  timeline: 'Open timeline',
  activity: 'Open run history'
};

function itemRow(item) {
  const badge = item.staleness ? stalenessBadge(item.staleness.status) : `<span class="badge">${escapeHtml(KIND_LABEL[item.kind] || item.kind)}</span>`;
  const actions = (item.actions || []).map((action) =>
    `<button class="button" data-inbox-action="${escapeHtml(action)}" data-inbox-key="${escapeHtml(item.key)}">${escapeHtml(ACTION_LABEL[action] || action)}</button>`
  ).join('');
  return `
    <article class="inbox-item" data-inbox-item="${escapeHtml(item.key)}" data-kind="${escapeHtml(item.kind)}">
      <div class="inbox-item-head">
        <div><p class="eyebrow">${escapeHtml(KIND_LABEL[item.kind] || item.kind)}</p><strong>${escapeHtml(item.title)}</strong></div>
        ${badge}
      </div>
      <p class="inbox-detail">${escapeHtml(item.detail || '')}</p>
      ${item.subject ? `<p class="muted-copy inbox-subject">${escapeHtml(item.subject)}</p>` : ''}
      <div class="button-row inbox-actions">${actions}<a class="view-all-link" href="#/${escapeHtml(item.route)}">${escapeHtml(ROUTE_LABEL[item.route] || 'Open')} &rarr;</a></div>
      <div class="inbox-result" data-inbox-result="${escapeHtml(item.key)}"></div>
    </article>`;
}

function impactSummary(result) {
  const list = (title, nodes) => `<div><strong>${escapeHtml(title)}</strong> <span class="badge">${nodes.length}</span>${nodes.length ? `<ul class="feature-impact-list">${nodes.slice(0, 6).map((node) => `<li><code>${escapeHtml(node.path || node.sourcePath || node.name || node.id)}</code></li>`).join('')}</ul>` : ''}</div>`;
  return `<p class="settings-copy">Impact: <strong>${escapeHtml(String(result.risk).toUpperCase())}</strong> · ${result.edges.length} structural relationship${result.edges.length === 1 ? '' : 's'}</p><div class="feature-impact-grid">${list('Matches', result.directMatches)}${list('Dependents', result.dependents)}${list('Tests', result.tests)}</div>`;
}

export async function initInbox(container, { project, api, onChanged }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading decisions waiting on you…</div>';
  let inbox;
  try {
    inbox = await api.getInbox(project.id);
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Inbox unavailable', error.message)}</div>`;
    return;
  }
  const counts = inbox.counts || {};
  container.innerHTML = `
    <article class="panel" id="inboxPanel">
      <div class="panel-header">
        <div><p class="eyebrow">Needs a human decision</p><h2>Planning inbox</h2></div>
        <div class="inbox-counts">${Object.entries(KIND_LABEL).map(([kind, label]) => `<span class="badge">${escapeHtml(label)} ${counts[kind] || 0}</span>`).join('')}</div>
      </div>
      <div class="panel-body">
        ${inbox.items.length ? `<div class="inbox-list">${inbox.items.map(itemRow).join('')}</div>` : emptyState('IN', 'Nothing is waiting on you', 'Drifted plans, proposals, and failed runs with no follow-up appear here.')}
        ${inbox.stalenessTruncated ? `<p class="field-hint">Only the ${inbox.stalenessCheckLimit} most recently accepted plans were checked for drift. Older plans are not reported here.</p>` : ''}
        <p class="field-hint">Items are derived from planning requests and runs. Dismissing one records your decision; it never changes the record it came from.</p>
      </div>
    </article>`;

  const byKey = new Map(inbox.items.map((item) => [item.key, item]));
  const reload = async () => {
    await onChanged?.();
    await initInbox(container, { project, api, onChanged });
  };

  const run = async (button, item, action) => {
    const target = container.querySelector(`[data-inbox-result="${CSS.escape(item.key)}"]`);
    button.disabled = true;
    try {
      if (action === 'analyze') {
        const result = await api.getMemoryImpact(project.id, item.subject);
        target.innerHTML = impactSummary(result);
        button.disabled = false;
        return;
      }
      if (action === 'reground') {
        await api.regroundPlanningRequest(project.id, item.planningRequestId);
        showToast('Re-grounded plan proposed alongside the accepted one');
      } else if (action === 'convert') {
        await api.addIssue(project.id, item.convert);
        showToast('Issue created from inbox item');
      } else if (action === 'dismiss') {
        await api.dismissInboxItem(project.id, item.key);
        showToast('Item dismissed');
      }
      await reload();
    } catch (error) {
      showToast(error.message, 'error');
      target.innerHTML = `<p class="draft-error">${escapeHtml(error.message)}</p>`;
      button.disabled = false;
    }
  };

  container.querySelectorAll('[data-inbox-action]').forEach((button) => button.addEventListener('click', () => {
    const item = byKey.get(button.dataset.inboxKey);
    if (item) void run(button, item, button.dataset.inboxAction);
  }));
}
