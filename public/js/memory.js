import { emptyState, escapeHtml, showToast } from './components.js';

function statusLabel(status) {
  if (status.state === 'unindexed') return 'Not indexed';
  if (status.stale) return 'Stale';
  return 'Current';
}

function nodeList(items) {
  if (!items.length) return '<p class="settings-copy">No matching graph nodes.</p>';
  return `<ul class="memory-node-list">${items.map((item) => `<li><button class="memory-node" data-memory-node="${escapeHtml(item.id)}"><span class="badge">${escapeHtml(item.type)}</span><code>${escapeHtml(item.path || item.name)}</code></button></li>`).join('')}</ul>`;
}

export async function initMemory(container, { project, api }) {
  let status;
  try {
    status = await api.getMemoryStatus(project.id);
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Memory unavailable', error.message)}</div>`;
    return;
  }
  container.innerHTML = `
    <div class="memory-grid">
      <article class="panel memory-status"><div class="panel-header"><div><p class="eyebrow">Local project intelligence</p><h2>Memory index</h2></div><span class="badge" id="memoryState">${escapeHtml(statusLabel(status))}</span></div><div class="panel-body"><dl class="settings-facts"><div><dt>Repository</dt><dd><code>${escapeHtml(status.repositorySha.slice(0, 12))}</code></dd></div><div><dt>Indexed</dt><dd>${status.indexedSha ? `<code>${escapeHtml(status.indexedSha.slice(0, 12))}</code>` : 'Not yet indexed'}</dd></div><div><dt>Graph</dt><dd>${status.counts.files} files · ${status.counts.nodes} nodes · ${status.counts.edges} edges</dd></div><div><dt>Quality</dt><dd>Level ${status.qualityLevel} · file graph</dd></div></dl><div class="button-row"><button class="button primary" id="refreshMemory">${status.stale ? 'Refresh memory' : 'Rebuild memory'}</button></div><p class="field-hint">Indexes remain local. Secrets, binary files, build output, and <code>.gateignore</code> paths are excluded.</p></div></article>
      <article class="panel"><div class="panel-header"><div><p class="eyebrow">Hybrid retrieval foundation</p><h2>Search memory</h2></div></div><div class="panel-body"><form class="form-grid" id="memorySearchForm"><div class="field"><label for="memorySearch">File or module</label><input id="memorySearch" autocomplete="off" placeholder="provider cancellation" maxlength="500"></div><button class="button" type="submit">Search</button></form><div id="memorySearchResults" class="memory-results">${emptyState('◇', 'Search the file graph', 'Search results retain their local filesystem provenance.')}</div></div></article>
      <article class="panel settings-wide"><div class="panel-header"><div><p class="eyebrow">Deterministic impact preview</p><h2>Impact</h2></div></div><div class="panel-body"><form class="form-grid memory-impact-form" id="memoryImpactForm"><div class="field"><label for="memoryImpact">Goal, filename, or module</label><input id="memoryImpact" autocomplete="off" placeholder="provider streaming" maxlength="500"></div><button class="button" type="submit">Analyze impact</button></form><div id="memoryImpactResults" class="memory-results"><p class="settings-copy">Impact starts with matching file nodes and their direct structural neighbors. Semantic and symbol retrieval arrive in later intelligence levels.</p></div></div></article>
    </div>`;

  async function showNeighbors(nodeId) {
    try {
      const graph = await api.getMemoryNeighbors(project.id, nodeId, 1);
      const text = graph.nodes.map((node) => node.path || node.name).join(', ') || 'No connected nodes.';
      showToast(`Graph neighborhood: ${text.slice(0, 220)}`);
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
  function bindNodes(target) {
    target.querySelectorAll('[data-memory-node]').forEach((button) => button.addEventListener('click', () => showNeighbors(button.dataset.memoryNode)));
  }
  container.querySelector('#refreshMemory').addEventListener('click', async () => {
    const button = container.querySelector('#refreshMemory');
    button.disabled = true;
    try {
      const refreshed = await api.refreshMemory(project.id, { force: status.state === 'unindexed' });
      showToast(`Memory ${refreshed.mode === 'unchanged' ? 'is already current' : 'refreshed'}`);
      await initMemory(container, { project, api });
    } catch (error) {
      showToast(error.message, 'error');
      button.disabled = false;
    }
  });
  container.querySelector('#memorySearchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = container.querySelector('#memorySearch').value.trim();
    if (!query) return;
    try {
      const result = await api.searchMemory(project.id, query);
      const target = container.querySelector('#memorySearchResults');
      target.innerHTML = nodeList(result.items);
      bindNodes(target);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  container.querySelector('#memoryImpactForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = container.querySelector('#memoryImpact').value.trim();
    if (!query) return;
    try {
      const result = await api.getMemoryImpact(project.id, query);
      const target = container.querySelector('#memoryImpactResults');
      target.innerHTML = `<p class="settings-copy">Impact: <strong>${escapeHtml(result.risk.toUpperCase())}</strong> · ${result.directMatches.length} direct file match${result.directMatches.length === 1 ? '' : 'es'}</p>${nodeList(result.directMatches)}`;
      bindNodes(target);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
}
