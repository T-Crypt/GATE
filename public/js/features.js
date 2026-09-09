import { emptyState, escapeHtml, showToast } from './components.js';

function nodeName(node) {
  return node.path || node.sourcePath || node.name || node.id;
}

export function planningReview(plan) {
  const impact = plan.impact || { directMatches: [], dependents: [], tests: [], risk: 'low' };
  const nodes = (items) => items.length ? `<ul class="feature-impact-list">${items.map((item) => `<li><code>${escapeHtml(nodeName(item))}</code></li>`).join('')}</ul>` : '<span class="muted-copy">None identified</span>';
  return `<article class="feature-plan" data-plan-id="${escapeHtml(plan.id)}"><div class="panel-header"><div><p class="eyebrow">Grounded proposal</p><h3>${escapeHtml(plan.goal)}</h3></div><span class="badge">${escapeHtml(String(impact.risk || 'low').toUpperCase())}</span></div><div class="feature-impact-grid"><div><strong>Matches</strong>${nodes(impact.directMatches || [])}</div><div><strong>Dependents</strong>${nodes(impact.dependents || [])}</div><div><strong>Tests</strong>${nodes(impact.tests || [])}</div></div><p class="settings-copy">${plan.draft.graph.nodes.length} timeline nodes · ${plan.context.estimatedTokens}/${plan.context.tokenBudget} estimated context tokens · revision <code>${escapeHtml(plan.provenance.memoryRevisionSha.slice(0, 12))}</code></p>${plan.status === 'proposed' ? `<button class="button primary" data-accept-plan="${escapeHtml(plan.id)}">Accept proposed timeline</button>` : '<span class="badge">Accepted</span>'}</article>`;
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
}

export async function initFeatures(container, { project, api }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading features…</div>';
  try {
    const features = await api.listFeatures(project.id);
    container.innerHTML = `<div class="features-layout"><article class="panel"><div class="panel-header"><div><p class="eyebrow">Durable work</p><h2>Features</h2></div></div><div class="panel-body"><form class="form-grid" id="featureForm"><div class="field"><label for="featureTitle">Title</label><input id="featureTitle" required maxlength="500" placeholder="Add Codex provider"></div><div class="field"><label for="featureIntent">Intent</label><textarea id="featureIntent" required maxlength="20000" placeholder="Describe the outcome and constraints"></textarea></div><button class="button primary">Create feature</button></form><div class="feature-list">${features.length ? features.map((feature) => `<button class="feature-card" data-feature-id="${escapeHtml(feature.id)}"><span><strong>${escapeHtml(feature.title)}</strong><small>${escapeHtml(feature.intent)}</small></span><span class="badge">${escapeHtml(feature.status)}</span></button>`).join('') : emptyState('FT', 'No features yet', 'Create a durable workspace for major planned work.')}</div></div></article><section id="featureDetail" class="panel"><div class="panel-body">${emptyState('◇', 'Select a feature', 'Review intent, impact, context, and proposed timeline here.')}</div></section></div>`;

    async function showFeature(featureId) {
      const feature = features.find((item) => item.id === featureId);
      const plans = await api.listFeaturePlans(project.id, featureId);
      const detail = container.querySelector('#featureDetail');
      detail.innerHTML = `<div class="panel-header"><div><p class="eyebrow">Feature workspace</p><h2>${escapeHtml(feature.title)}</h2></div><span class="badge">${escapeHtml(feature.status)}</span></div><div class="panel-body"><p>${escapeHtml(feature.intent)}</p><div class="button-row"><button class="button primary" id="planFeature" ${feature.status === 'cancelled' || feature.status === 'complete' || plans.some((plan) => plan.status === 'proposed') ? 'disabled' : ''}>Plan feature</button></div><div class="feature-plans">${plans.map(planningReview).join('') || '<p class="muted-copy">No plans yet.</p>'}</div></div>`;
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
