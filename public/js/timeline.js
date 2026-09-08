import { emptyState, escapeHtml, showToast } from './components.js';

const passedStatuses = new Set(['complete', 'approved']);

function gateLabel(type) {
  return ({ code: 'Code', test: 'Test', build: 'Build', plan: 'Plan', visual: 'Visual', approval: 'Approval' })[type] || type;
}

function statusLabel(status) {
  return String(status || 'planned').replaceAll('_', ' ');
}

// Deterministic pick from the fixed .mc-0..mc-9 palette in style.css, so a
// milestone always renders the same identity color across reloads without
// persisting anything server-side. A page's CSP forbids inline styles, so the
// palette lives in the stylesheet and this only ever returns a class name.
const MILE_COLOR_COUNT = 10;
function milestoneColorClass(key) {
  let hash = 0;
  for (const char of String(key)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `mc-${hash % MILE_COLOR_COUNT}`;
}

function ownerMilestoneId(node) {
  return node.kind === 'milestone' ? node.id : node.parentId;
}

// Aggregates a milestone's own status from its child steps rather than the
// milestone node's own (often-static) status field, so the badge reflects
// what's actually happened underneath it.
function aggregateMilestoneStatus(steps) {
  if (!steps.length) return { label: 'planned', tone: '' };
  if (steps.every((step) => passedStatuses.has(step.status))) return { label: 'complete', tone: 'complete' };
  if (steps.some((step) => step.status === 'blocked')) return { label: 'blocked', tone: 'failed' };
  if (steps.some((step) => step.status === 'running')) return { label: 'running', tone: 'running' };
  if (steps.some((step) => step.status === 'review')) return { label: 'review', tone: 'review' };
  return { label: 'planned', tone: '' };
}

// For each milestone, finds incoming edges from nodes it does not own (i.e. steps
// or milestones outside it) and reports whether any such source hasn't passed yet —
// that's what "gates" this milestone from the rest of the plan.
function computeMilestoneGating(milestones, allNodes, edges) {
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const result = new Map();
  for (const milestone of milestones) {
    const memberIds = new Set([
      milestone.id,
      ...allNodes.filter((node) => node.parentId === milestone.id).map((node) => node.id)
    ]);
    const incoming = edges.filter((edge) => memberIds.has(edge.toNodeId) && !memberIds.has(edge.fromNodeId));
    const sources = incoming.map((edge) => byId.get(edge.fromNodeId)).filter(Boolean);
    const blockers = sources.filter((node) => !passedStatuses.has(node.status));
    const gatingKeys = [...new Set(blockers.map((node) => {
      const owner = byId.get(ownerMilestoneId(node));
      return owner ? owner.key : node.key;
    }))];
    result.set(milestone.id, { locked: blockers.length > 0, gatingKeys });
  }
  return result;
}

function renderMileRail(milestones, gating) {
  if (milestones.length < 2) return '';
  return `<div class="mile-rail" role="list" aria-label="Milestone gating overview">${milestones.map((milestone, index) => {
    const info = gating.get(milestone.id) || { locked: false, gatingKeys: [] };
    return `<button type="button" class="mile-marker ${milestoneColorClass(milestone.key)}" role="listitem" data-mile-target="${escapeHtml(milestone.id)}" data-locked="${info.locked}" title="${escapeHtml(milestone.title)}${info.locked ? ` — gated by ${escapeHtml(info.gatingKeys.join(', '))}` : ''}">
      <span class="mile-dot">${escapeHtml(String(index + 1))}</span>
      <span class="mile-key">${escapeHtml(milestone.key)}</span>
      <small>${info.locked ? 'gated' : statusLabel(milestone.status)}</small>
    </button>`;
  }).join('')}</div>`;
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
    const gating = computeMilestoneGating(milestones, timeline.nodes, timeline.edges);
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
        ${renderMileRail(milestones, gating)}
        <div class="timeline-ruler"><span>Plan</span><span>Build</span><span>Verify</span><span>Review</span></div>
        ${milestones.length ? `<div class="timeline-scroll"><div class="timeline-canvas"><svg class="dependency-svg" aria-hidden="true"></svg>${milestones.map((milestone) => {
          const info = gating.get(milestone.id) || { locked: false, gatingKeys: [] };
          const steps = timeline.nodes.filter((node) => node.parentId === milestone.id);
          const aggregate = aggregateMilestoneStatus(steps);
          return `<section class="milestone-lane ${milestoneColorClass(milestone.key)}" data-node-id="${escapeHtml(milestone.id)}"><header><span class="milestone-key">${escapeHtml(milestone.key)}</span><div><h2>${escapeHtml(milestone.title)}</h2><p>${escapeHtml(milestone.description || `${steps.length} guided steps`)}</p>${info.locked ? `<p class="mile-gated-tag">Gated by ${escapeHtml(info.gatingKeys.join(', '))}</p>` : ''}</div><span class="badge"><span class="status-dot ${escapeHtml(aggregate.tone)}"></span>${escapeHtml(aggregate.label)}</span></header><div class="milestone-steps">${steps.map((step) => renderStep(step, timeline)).join('')}</div></section>`;
        }).join('')}</div></div>` : emptyState('TL', 'No timeline yet', 'Describe the outcome above. Claude can propose a dependency-aware plan for review.')}
      </section>`;

    const redraw = () => drawConnections(container, timeline);
    requestAnimationFrame(redraw);
    const observer = new ResizeObserver(redraw);
    observer.observe(container.querySelector('.timeline-shell'));

    container.querySelectorAll('[data-mile-target]').forEach((marker) => marker.addEventListener('click', () => {
      const lane = container.querySelector(`.milestone-lane[data-node-id="${CSS.escape(marker.dataset.mileTarget)}"]`);
      if (!lane) return;
      lane.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      lane.classList.add('flash');
      setTimeout(() => lane.classList.remove('flash'), 900);
    }));

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
