import { emptyState, escapeHtml, showToast } from './components.js';

function nodeName(node) {
  return node.path || node.sourcePath || node.name || node.id;
}

// Options on an accepted plan mirror the review boundary: re-ground it, read
// what changed, or keep it. Nothing here discards approved work.
function stalenessPanel(plan, staleness) {
  if (!staleness) return '';
  const changed = staleness.changedGroundingFiles || [];
  const actions = staleness.status === 'CURRENT'
    ? ''
    : `<div class="button-row"><button class="button" data-reground-plan="${escapeHtml(plan.id)}">Re-ground milestone</button><span class="muted-copy">Keeping the existing plan changes nothing.</span></div>`;
  return `<p class="settings-copy">${stalenessBadge(staleness.status)} ${escapeHtml(staleness.reason)}</p>${changed.length ? `<ul class="feature-impact-list">${changed.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join('')}</ul>` : ''}${actions}`;
}

// CURRENT, POSSIBLY_STALE, and STALE mean different things to a human about to
// start work, so they must not render identically. The classes map onto the
// existing green/amber/red status palette rather than a new color system.
export function stalenessBadge(status) {
  const known = ['CURRENT', 'POSSIBLY_STALE', 'STALE'].includes(status) ? status.toLowerCase() : 'unknown';
  return `<span class="badge staleness ${known}">${escapeHtml(status)}</span>`;
}

// The pre-execution staleness check is only worth computing if the human sees
// it. A toast scrolls away before a run finishes starting, so warnings render
// as a panel that stays until it is dismissed or re-grounded.
export function planWarningPanel(warnings) {
  if (!warnings?.length) return '';
  return `<section class="panel plan-warning" role="alert" data-testid="plan-warnings"><div class="panel-header"><div><p class="eyebrow">Pre-execution check</p><h2>${warnings.length === 1 ? 'This run started against a drifted plan' : `${warnings.length} runs started against drifted plans`}</h2></div><button class="button" data-dismiss-plan-warnings>Dismiss</button></div><div class="panel-body">${warnings.map((warning) => {
    const changed = warning.changedGroundingFiles || [];
    return `<article class="plan-warning-item"><p class="settings-copy">${stalenessBadge(warning.status)} ${escapeHtml(warning.reason)}</p>${changed.length ? `<ul class="feature-impact-list">${changed.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join('')}</ul>` : ''}<div class="button-row"><button class="button" data-reground-plan="${escapeHtml(warning.planningRequestId)}">Re-ground milestone</button><a class="view-all-link" href="#/inbox">Open in inbox &rarr;</a></div></article>`;
  }).join('')}<p class="field-hint">The run was not blocked. Gate never rewrites an approved plan on your behalf.</p></div></section>`;
}

export function planningReview(plan, staleness) {
  const impact = plan.impact || { directMatches: [], dependents: [], tests: [], risk: 'low' };
  const nodes = (items) => items.length ? `<ul class="feature-impact-list">${items.map((item) => `<li><code>${escapeHtml(nodeName(item))}</code></li>`).join('')}</ul>` : '<span class="muted-copy">None identified</span>';
  const supersedes = plan.supersedesId ? `<p class="muted-copy">Re-grounded from plan <code>${escapeHtml(plan.supersedesId.slice(0, 8))}</code></p>` : '';
  return `<article class="feature-plan" data-plan-id="${escapeHtml(plan.id)}"><div class="panel-header"><div><p class="eyebrow">Grounded proposal</p><h3>${escapeHtml(plan.goal)}</h3></div><span class="badge">${escapeHtml(String(impact.risk || 'low').toUpperCase())}</span></div>${supersedes}<div class="feature-impact-grid"><div><strong>Matches</strong>${nodes(impact.directMatches || [])}</div><div><strong>Dependents</strong>${nodes(impact.dependents || [])}</div><div><strong>Tests</strong>${nodes(impact.tests || [])}</div></div><p class="settings-copy">${plan.draft.graph.nodes.length} timeline nodes · ${plan.context.estimatedTokens}/${plan.context.tokenBudget} estimated context tokens · revision <code>${escapeHtml(plan.provenance.memoryRevisionSha.slice(0, 12))}</code></p>${stalenessPanel(plan, staleness)}${plan.status === 'proposed' ? `<button class="button primary" data-accept-plan="${escapeHtml(plan.id)}">Accept proposed timeline</button>` : '<span class="badge">Accepted</span>'}</article>`;
}

export function bindPlanningReview(container, { project, api, onAccepted }) {
  container.querySelectorAll('[data-accept-plan]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api.acceptPlanningRequest(project.id, button.dataset.acceptPlan);
      showToast('Proposed timeline accepted');
      await onAccepted?.();
    } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
  }));
  container.querySelectorAll('[data-reground-plan]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api.regroundPlanningRequest(project.id, button.dataset.regroundPlan);
      showToast('Re-grounded plan proposed alongside the accepted one');
      await onAccepted?.();
    } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
  }));
}

// Staleness is advisory and needs a request per accepted plan, so a plan that
// cannot be checked simply renders without a badge.
export async function planStaleness(api, project, plans) {
  const entries = await Promise.all(plans.filter((plan) => plan.status === 'accepted').map(async (plan) => {
    try { return [plan.id, await api.getPlanningStaleness(project.id, plan.id)]; }
    catch { return null; }
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

export async function initFeatures(container, { project, api }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading features…</div>';
  try {
    const features = await api.listFeatures(project.id);
    container.innerHTML = `<div class="features-layout"><article class="panel"><div class="panel-header"><div><p class="eyebrow">Durable work</p><h2>Features</h2></div></div><div class="panel-body"><form class="form-grid" id="featureForm"><div class="field"><label for="featureTitle">Title</label><input id="featureTitle" required maxlength="500" placeholder="Add Codex provider"></div><div class="field"><label for="featureIntent">Intent</label><textarea id="featureIntent" required maxlength="20000" placeholder="Describe the outcome and constraints"></textarea></div><button class="button primary">Create feature</button></form><div class="feature-list">${features.length ? features.map((feature) => `<button class="feature-card" data-feature-id="${escapeHtml(feature.id)}"><span><strong>${escapeHtml(feature.title)}</strong><small>${escapeHtml(feature.intent)}</small></span><span class="badge">${escapeHtml(feature.status)}</span></button>`).join('') : emptyState('FT', 'No features yet', 'Create a durable workspace for major planned work.')}</div></div></article><section id="featureDetail" class="panel"><div class="panel-body">${emptyState('◇', 'Select a feature', 'Review intent, impact, context, and proposed timeline here.')}</div></section></div>`;

    async function showFeature(featureId) {
      const feature = features.find((item) => item.id === featureId);
      const plans = await api.listFeaturePlans(project.id, featureId);
      const staleness = await planStaleness(api, project, plans);
      const detail = container.querySelector('#featureDetail');
      detail.innerHTML = `<div class="panel-header"><div><p class="eyebrow">Feature workspace</p><h2>${escapeHtml(feature.title)}</h2></div><span class="badge">${escapeHtml(feature.status)}</span></div><div class="panel-body"><p>${escapeHtml(feature.intent)}</p><div class="button-row"><button class="button primary" id="planFeature" ${feature.status === 'cancelled' || feature.status === 'complete' || plans.some((plan) => plan.status === 'proposed') ? 'disabled' : ''}>Plan feature</button></div><div class="feature-plans">${plans.map((plan) => planningReview(plan, staleness[plan.id])).join('') || '<p class="muted-copy">No plans yet.</p>'}</div></div>`;
      detail.querySelector('#planFeature')?.addEventListener('click', async (event) => {
        event.currentTarget.disabled = true;
        try { await api.planFeature(project.id, featureId); showToast('Feature plan proposed'); await initFeatures(container, { project, api }); }
        catch (error) { showToast(error.message, 'error'); event.currentTarget.disabled = false; }
      });
      bindPlanningReview(detail, { project, api, onAccepted: () => initFeatures(container, { project, api }) });
    }
    container.querySelectorAll('[data-feature-id]').forEach((button) => button.addEventListener('click', () => showFeature(button.dataset.featureId)));
    container.querySelector('#featureForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try { await api.createFeature(project.id, { title: form.querySelector('#featureTitle').value, intent: form.querySelector('#featureIntent').value }); showToast('Feature created'); await initFeatures(container, { project, api }); }
      catch (error) { showToast(error.message, 'error'); }
    });
  } catch (error) { container.innerHTML = `<div class="panel">${emptyState('!', 'Features unavailable', error.message)}</div>`; }
}
