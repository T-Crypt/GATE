import { escapeHtml, providerModelDefault, providerName, showToast } from './components.js';
import { applyAccent, getAccent } from './theme.js';

const ACCENTS = [
  ['cyan', 'Cyan'],
  ['blue', 'Blue'],
  ['purple', 'Purple'],
  ['green', 'Green'],
  ['orange', 'Orange'],
  ['pink', 'Pink'],
  ['red', 'Red']
];

export function initSettings(container, { project, api, onProjectChanged }) {
  const protectedBranches = new Set(project.protectedBranches);
  const activeAccent = getAccent();
  container.innerHTML = `
    <div class="settings-grid">
      <article class="panel settings-card"><div class="panel-header"><div><p class="eyebrow">This device only</p><h2>Appearance</h2></div></div><div class="panel-body"><p class="settings-copy">Accent color is a display preference stored in this browser. It is not shared with anyone else who opens this project.</p><div class="accent-swatches" role="radiogroup" aria-label="Accent color">${ACCENTS.map(([value, label]) => `<button type="button" class="accent-swatch accent-${escapeHtml(value)}" data-accent-choice="${escapeHtml(value)}" role="radio" aria-checked="${value === activeAccent}" aria-label="${escapeHtml(label)}"></button>`).join('')}</div></div></article>
      <form class="panel settings-card" id="settingsForm"><div class="panel-header"><div><p class="eyebrow">Hard boundary</p><h2>Protected branches</h2></div><span class="lock-mark">LOCKED</span></div><div class="panel-body"><p class="settings-copy">Automatic work can branch from these refs, but Gate will never execute on, merge into, push, delete, or rewrite them.</p><div class="protected-list">${[...protectedBranches].map((branch) => `<label class="protected-row"><input type="checkbox" checked disabled aria-label="${escapeHtml(branch)} protected"><span><strong>${escapeHtml(branch)}</strong>${branch === project.baseBranch ? '<small>Base branch · protection cannot be removed</small>' : '<small>Policy protected</small>'}</span><span class="lock-mark">IMMUTABLE</span></label>`).join('')}</div></div></form>
      <article class="panel settings-card"><div class="panel-header"><div><p class="eyebrow">Human control</p><h2>Interaction level</h2></div></div><div class="panel-body field"><label for="interactionLevel">Agent autonomy</label><select id="interactionLevel"><option value="observe" ${project.interactionLevel === 'observe' ? 'selected' : ''}>Observe only</option><option value="assist" ${project.interactionLevel === 'assist' ? 'selected' : ''}>Assist with approvals</option><option value="automatic" ${project.interactionLevel === 'automatic' ? 'selected' : ''}>Automatic inside gates</option><option value="custom" ${project.interactionLevel === 'custom' ? 'selected' : ''}>Custom policy</option></select><span class="field-hint">Even automatic mode stops at human gates and never integrates branches.</span></div></article>
<article class="panel settings-card"><div class="panel-header"><div><p class="eyebrow">Release refs</p><h2>Stable and production</h2></div></div><div class="panel-body form-grid"><div class="field"><label for="stableBranchSetting">Stable branch</label><input id="stableBranchSetting" value="${escapeHtml(project.stableBranch || '')}" placeholder="stable"></div><div class="field"><label for="productionBranchSetting">Production branch</label><input id="productionBranchSetting" value="${escapeHtml(project.productionBranch || '')}" placeholder="production"></div><div class="field"><label for="branchPrefixSetting">Branch naming prefix</label><input id="branchPrefixSetting" value="${escapeHtml(project.branchPrefix || 'work/gate-')}" maxlength="250"><span class="field-hint">Prefix for every isolated run branch, e.g. <code>work/gate-&lt;run&gt;</code>.</span></div><button class="button primary" type="submit">Save safety policy</button></div></article>
      <form class="panel settings-card" id="providerForm"><div class="panel-header"><div><p class="eyebrow">Provider adapter</p><h2>Agent backend</h2></div><span class="badge">${escapeHtml(project.providerKind)}</span></div><div class="panel-body"><div class="form-grid"><div class="field"><label for="providerKindSetting">Backend provider</label><select id="providerKindSetting"><option value="claude" ${project.providerKind === 'claude' ? 'selected' : ''}>Claude Code</option><option value="opencode" ${project.providerKind === 'opencode' ? 'selected' : ''}>OpenCode</option></select></div><div class="field"><label for="providerModelSetting">Model</label><input id="providerModelSetting" value="${escapeHtml(project.providerConfig.model || '')}" placeholder="${escapeHtml(providerModelDefault(project.providerKind))}"><span class="field-hint">Blank uses the provider's default. OpenCode can draft with e.g. <code>opencode/big-pickle</code>.</span></div></div><dl class="settings-facts"><div><dt>Repository</dt><dd>${escapeHtml(project.repoPath)}</dd></div><div><dt>Base</dt><dd>${escapeHtml(project.baseBranch)}</dd></div><div><dt>Storage</dt><dd>Local SQLite + event log</dd></div><div><dt>Telemetry</dt><dd>None</dd></div></dl><button class="button primary" type="submit">Save provider</button></div></form>
    </div>`;
  container.querySelectorAll('[data-accent-choice]').forEach((button) => button.addEventListener('click', () => {
    applyAccent(button.dataset.accentChoice);
    container.querySelectorAll('[data-accent-choice]').forEach((other) => other.setAttribute('aria-checked', String(other === button)));
  }));
  container.querySelector('#settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const interactionLevel = container.querySelector('#interactionLevel').value;
    const stableBranch = container.querySelector('#stableBranchSetting').value.trim() || null;
    const productionBranch = container.querySelector('#productionBranchSetting').value.trim() || null;
    const branchPrefix = container.querySelector('#branchPrefixSetting').value.trim() || 'work/gate-';
    try {
      const updated = await api.updatePolicy(project.id, { interactionLevel, stableBranch, productionBranch, branchPrefix });
      showToast('Safety policy saved');
      onProjectChanged(updated);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  container.querySelector('#providerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const providerKind = container.querySelector('#providerKindSetting').value;
    const model = container.querySelector('#providerModelSetting').value.trim() || null;
    try {
      const updated = await api.updateProvider(project.id, { providerKind, providerConfig: { model } });
      showToast(`${providerName(providerKind)} provider saved`);
      onProjectChanged(updated);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  container.querySelector('#providerKindSetting').addEventListener('change', (event) => {
    const input = container.querySelector('#providerModelSetting');
    if (!input.value) input.placeholder = providerModelDefault(event.target.value);
  });
}
