import { emptyState, escapeHtml, showToast } from './components.js';

function evidenceLabel(gate) {
  if (gate.evidenceState === 'stale') return '<strong class="evidence-warning">Evidence is stale</strong><span>Its commit does not match the current run HEAD.</span>';
  if (gate.evidenceState === 'fresh') return '<strong class="evidence-ok">Evidence is current</strong><span>Bound to the current run HEAD.</span>';
  return '<strong>Evidence required</strong><span>Attach tests, build output, or a visual artifact before approval.</span>';
}

export async function initReviews(container, { project, api }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading review evidence…</div>';
  try {
    const bundle = await api.getReview(project.id);
    container.innerHTML = bundle.gates.length ? `<div class="review-grid">${bundle.gates.map((gate) => `
      <article class="panel review-card" data-state="${escapeHtml(gate.evidenceState)}">
        <div class="panel-header"><div><p class="eyebrow">${escapeHtml(gate.type)} gate</p><h2>${escapeHtml(gate.title)}</h2></div><span class="badge">${escapeHtml(gate.status)}</span></div>
        <div class="panel-body">
          <div class="evidence-state">${evidenceLabel(gate)}</div>
          ${gate.latestEvidence ? `<dl class="evidence-detail"><div><dt>Evidence</dt><dd>${escapeHtml(gate.latestEvidence.kind)}</dd></div><div><dt>HEAD</dt><dd><code>${escapeHtml(gate.latestEvidence.headSha.slice(0, 12))}</code></dd></div>${gate.latestEvidence.command ? `<div><dt>Command</dt><dd><code>${escapeHtml(gate.latestEvidence.command)}</code></dd></div>` : ''}${gate.latestEvidence.artifactPath ? `<div><dt>Artifact</dt><dd>${escapeHtml(gate.latestEvidence.artifactPath)}</dd></div>` : ''}</dl>` : ''}
          <label for="review-note-${escapeHtml(gate.id)}">Review note</label><textarea id="review-note-${escapeHtml(gate.id)}" class="review-note" placeholder="Why this decision is safe"></textarea>
          <div class="button-row review-actions"><button class="button primary approve-gate" data-id="${escapeHtml(gate.id)}" ${gate.canApprove ? '' : 'disabled'}>Approve step</button><button class="button danger reject-gate" data-id="${escapeHtml(gate.id)}">Reject step</button></div>
        </div>
      </article>`).join('')}</div>` : `<div class="panel">${emptyState('RV', 'Nothing waiting for review', 'Approval, test, build, and visual gates appear here when the timeline creates them.')}</div>`;

    const decide = async (button, decision) => {
      const gateId = button.dataset.id;
      const note = container.querySelector(`#review-note-${CSS.escape(gateId)}`).value.trim();
      button.disabled = true;
      try {
        await api.decideGate(project.id, gateId, { decision, note });
        showToast(decision === 'approved' ? 'Gate approved by human' : 'Gate rejected');
        await initReviews(container, { project, api });
      } catch (error) {
        showToast(error.message, 'error');
        button.disabled = false;
      }
    };
    container.querySelectorAll('.approve-gate').forEach((button) => button.addEventListener('click', () => decide(button, 'approved')));
    container.querySelectorAll('.reject-gate').forEach((button) => button.addEventListener('click', () => decide(button, 'rejected')));
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Review center unavailable', error.message)}</div>`;
  }
}
