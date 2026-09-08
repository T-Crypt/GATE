import { emptyState, escapeHtml, showToast } from './components.js';

const passedStatuses = new Set(['complete', 'approved']);

function gateLabel(type) {
  return ({ code: 'Code', test: 'Test', build: 'Build', plan: 'Plan', visual: 'Visual', approval: 'Approval' })[type] || type;
}

function statusLabel(status) {
  return String(status || 'planned').replaceAll('_', ' ');
}

function runnable(node, timeline) {
  if (!['planned', 'ready', 'blocked'].includes(node.status)) return false;
  const dependencies = timeline.edges
    .filter((edge) => edge.toNodeId === node.id)
    .map((edge) => timeline.nodes.find((candidate) => candidate.id === edge.fromNodeId))
    .filter(Boolean);
  const gates = timeline.gates.filter((gate) => gate.nodeId === node.id && gate.blocking);
  return dependencies.every((dependency) => passedStatuses.has(dependency.status)) &&
    gates.every((gate) => ['passed', 'approved', 'waived'].includes(gate.status));
}

function renderStep(step, timeline) {
  const gates = timeline.gates.filter((gate) => gate.nodeId === step.id);
  const canRun = runnable(step, timeline);
  return `
    <article class="step-card" data-testid="node-${escapeHtml(step.id)}" data-node-id="${escapeHtml(step.id)}" data-status="${escapeHtml(step.status)}" tabindex="0">
      <div class="step-topline"><span class="step-key">${escapeHtml(step.key)}</span><span class="status-dot ${escapeHtml(step.status)}"></span><span class="step-status">${escapeHtml(statusLabel(step.status))}</span></div>
      <h3>${escapeHtml(step.title)}</h3>
      ${step.description ? `<p>${escapeHtml(step.description)}</p>` : ''}
      <div class="gate-list">${gates.map((gate) => `<span class="gate-chip ${escapeHtml(gate.status)}"><span>${escapeHtml(gateLabel(gate.type))}</span><small>${escapeHtml(gate.status)}</small></span>`).join('')}</div>
      <div class="step-footer"><span>${step.progress}%</span><button class="step-run" data-run-node="${escapeHtml(step.id)}" ${canRun ? '' : 'disabled'} aria-label="Run ${escapeHtml(step.key)}">Run</button></div>
      <progress class="progress-track" max="100" value="${Number(step.progress) || 0}" aria-label="${escapeHtml(step.key)} progress"></progress>
    </article>`;
}

function dependencyText(edge, timeline) {
  const from = timeline.nodes.find((node) => node.id === edge.fromNodeId);
  const to = timeline.nodes.find((node) => node.id === edge.toNodeId);
  if (!from || !to) return '';
  return `${from.key} ${edge.type.endsWith('_gate') ? 'gates' : 'blocks'} ${to.key}`;
}

function drawConnections(container, timeline) {
  const canvas = container.querySelector('.timeline-canvas');
  const svg = container.querySelector('.dependency-svg');
  if (!canvas || !svg) return;
  const bounds = canvas.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  svg.innerHTML = timeline.edges.map((edge) => {
    const from = canvas.querySelector(`[data-node-id="${CSS.escape(edge.fromNodeId)}"]`);
    const to = canvas.querySelector(`[data-node-id="${CSS.escape(edge.toNodeId)}"]`);
    if (!from || !to) return '';
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x1 = a.right - bounds.left;
    const y1 = a.top + a.height / 2 - bounds.top;
    const x2 = b.left - bounds.left;
    const y2 = b.top + b.height / 2 - bounds.top;
    const bend = Math.max(42, Math.abs(x2 - x1) * 0.42);
    return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" data-edge-type="${escapeHtml(edge.type)}"></path>`;
  }).join('');
}

export async function initTimeline(container, { project, api, onRunChanged }) {
  container.innerHTML = '<div class="panel timeline-loading"><div class="loading-orbit"></div><span>Loading timeline…</span></div>';
  try {
    const timeline = await api.getTimeline(project.id);
    const milestones = timeline.nodes.filter((node) => node.kind === 'milestone');
    const completed = timeline.nodes.filter((node) => node.kind === 'step' && node.status === 'complete').length;
    const steps = timeline.nodes.filter((node) => node.kind === 'step').length;
    container.innerHTML = `
      <section class="goal-panel panel">
        <div><p class="eyebrow">Claude planning</p><h2>Turn a goal into guided execution</h2><p>Claude proposes milestones, dependencies, and gates. Nothing runs until the draft is accepted.</p></div>
        <form id="goalForm" class="goal-form"><label class="sr-only" for="goalInput">Project goal</label><textarea id="goalInput" rows="2" placeholder="Describe the outcome, constraints, and review expectations…" required minlength="3"></textarea><button class="button primary" type="submit">Draft timeline</button></form>
        <div id="draftResult"></div>
      </section>
      <section class="timeline-toolbar">
        <div class="timeline-summary"><span><strong>${completed}</strong> / ${steps} steps complete</span><span>${timeline.edges.length} dependencies</span><span>${timeline.gates.length} gates</span></div>
        <div class="button-row"><button class="button" id="fitTimeline">Fit timeline</button><button class="button primary" id="scheduleNext" ${steps ? '' : 'disabled'}>Start automatic execution</button></div>
      </section>
      ${timeline.edges.length ? `<div class="dependency-strip" aria-label="Timeline dependencies">${timeline.edges.map((edge) => `<span class="dependency-chip"><span class="edge-glyph">↗</span>${escapeHtml(dependencyText(edge, timeline))}<small>${escapeHtml(gateLabel(edge.type.replace('_gate', '')))}</small></span>`).join('')}</div>` : ''}
      <section class="panel timeline-shell">
        <div class="timeline-ruler"><span>Plan</span><span>Build</span><span>Verify</span><span>Review</span></div>
        ${milestones.length ? `<div class="timeline-scroll"><div class="timeline-canvas"><svg class="dependency-svg" aria-hidden="true"></svg>${milestones.map((milestone) => `<section class="milestone-lane"><header><span class="milestone-key">${escapeHtml(milestone.key)}</span><div><h2>${escapeHtml(milestone.title)}</h2><p>${escapeHtml(milestone.description || `${timeline.nodes.filter((node) => node.parentId === milestone.id).length} guided steps`)}</p></div><span class="badge">${escapeHtml(statusLabel(milestone.status))}</span></header><div class="milestone-steps">${timeline.nodes.filter((node) => node.parentId === milestone.id).map((step) => renderStep(step, timeline)).join('')}</div></section>`).join('')}</div></div>` : emptyState('TL', 'No timeline yet', 'Describe the outcome above. Claude can propose a dependency-aware plan for review.')}
      </section>`;

    const redraw = () => drawConnections(container, timeline);
    requestAnimationFrame(redraw);
    const observer = new ResizeObserver(redraw);
    observer.observe(container.querySelector('.timeline-shell'));

    container.querySelector('#goalForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button');
      const goal = event.currentTarget.querySelector('textarea').value.trim();
      button.disabled = true;
      button.textContent = 'Drafting…';
      try {
        const draft = await api.draftTimeline(project.id, goal);
        const result = container.querySelector('#draftResult');
        result.innerHTML = `<div class="draft-review"><div><strong>Proposed timeline</strong><span>${draft.graph.nodes.length} nodes · ${draft.graph.edges.length} dependencies</span></div><button class="button primary" id="acceptDraft">Accept draft</button></div>`;
        result.querySelector('#acceptDraft').addEventListener('click', async () => {
          await api.acceptTimelineDraft(project.id, draft.id);
          showToast('Timeline draft accepted');
          await initTimeline(container, { project, api, onRunChanged });
        });
      } catch (error) {
        showToast(error.message, 'error');
        button.disabled = false;
        button.textContent = 'Draft timeline';
      }
    });

    container.querySelectorAll('[data-run-node]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api.startStep(project.id, button.dataset.runNode);
        showToast('Claude run started');
        await onRunChanged?.();
        await initTimeline(container, { project, api, onRunChanged });
      } catch (error) {
        showToast(error.message, 'error');
        button.disabled = false;
      }
    }));
    container.querySelector('#scheduleNext')?.addEventListener('click', async () => {
      try {
        const runs = await api.schedule(project.id);
        showToast(runs.length ? 'Automatic execution started' : 'No step is ready');
        await onRunChanged?.();
        await initTimeline(container, { project, api, onRunChanged });
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
    container.querySelector('#fitTimeline')?.addEventListener('click', () => {
      container.querySelector('.timeline-scroll')?.scrollTo({ left: 0, behavior: 'smooth' });
    });
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Timeline unavailable', error.message, '<button class="button" id="retryTimeline">Retry</button>')}</div>`;
    container.querySelector('#retryTimeline')?.addEventListener('click', () => initTimeline(container, { project, api, onRunChanged }));
  }
}
