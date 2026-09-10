import { emptyState, escapeHtml, showToast } from './components.js';

function statusLabel(status) {
  if (status.state === 'unindexed') return 'Not indexed';
  if (status.stale) return 'Stale';
  return 'Current';
}

function nodeLabel(item) {
  if (item.type === 'symbol') {
    return `${item.sourcePath}:${item.metadata.line} — ${item.name} (${item.metadata.kind})`;
  }
  return item.path || item.name;
}

function nodeList(items, reasons = {}, badge) {
  if (!items.length) return '<p class="settings-copy">No matching graph nodes.</p>';
  return `<ul class="memory-node-list">${items.map((item) => {
    const matchReasons = reasons[item.id] || item.matchReasons || [];
    const strategy = item.matchStrategy
      ? `<span class="badge memory-match">${escapeHtml(item.matchStrategy)} ${Math.round(item.score * 100)}%</span>`
      : badge?.(item) || '';
    return `<li><button class="memory-node" data-memory-node="${escapeHtml(item.id)}"><span class="badge">${escapeHtml(item.type)}</span><span><code>${escapeHtml(nodeLabel(item))}</code>${matchReasons.length ? `<small class="memory-reason">${escapeHtml(matchReasons.join(' · '))}</small>` : ''}</span>${strategy}</button></li>`;
  }).join('')}</ul>`;
}

function citationList(citations) {
  if (!citations.length) return '<p class="settings-copy">No graph node supports an answer to that question.</p>';
  return `<ul class="memory-node-list">${citations.map((citation) => `<li><button class="memory-node" data-memory-node="${escapeHtml(citation.nodeId)}"><span class="badge">${escapeHtml(citation.type)}</span><span><code>${escapeHtml(citation.sourceLocation)}</code>${citation.reasons?.length ? `<small class="memory-reason">${escapeHtml(citation.reasons.join(' · '))}</small>` : ''}</span><span class="badge memory-match">${escapeHtml(citation.origin)}</span></button></li>`).join('')}</ul>`;
}

function godNodes(overview) {
  return `<section class="memory-impact-section"><h3>God nodes <span class="badge">${overview.items.length}</span></h3><p class="settings-copy">Ranked by recorded ${overview.edgeTypes.join(' + ')} degree across ${overview.analyzedNodes} of ${overview.totalNodes} indexed nodes${overview.truncated ? ' (truncated)' : ''}.</p>${nodeList(overview.items, {}, (item) => `<span class="badge memory-match">${item.degree} edges</span>`)}</section>`;
}

function communities(overview) {
  if (!overview.items.length) return '<section class="memory-impact-section"><h3>Communities <span class="badge">0</span></h3><p class="settings-copy">No module is connected to another by a recorded import or reference edge.</p></section>';
  return `<section class="memory-impact-section"><h3>Communities <span class="badge">${overview.count}</span></h3><p class="settings-copy">Connected components over ${overview.edgeTypes.join(' + ')} edges · ${overview.isolatedNodes} unconnected nodes.</p>${overview.items.map((community) => `<details class="context-capsule"><summary><span><strong>${escapeHtml(community.label)}</strong><small>${community.size} nodes</small></span><span class="badge">${escapeHtml(community.id)}</span></summary><div class="context-capsule-body">${nodeList(community.members, {}, (item) => `<span class="badge memory-match">${item.degree} edges</span>`)}</div></details>`).join('')}</section>`;
}

function impactSection(title, items, reasons) {
  return `<section class="memory-impact-section"><h3>${escapeHtml(title)} <span class="badge">${items.length}</span></h3>${nodeList(items, reasons)}</section>`;
}

function contextCapsules(capsules) {
  if (!capsules.length) return emptyState('▣', 'No compiled context yet', 'Compile a grounded capsule for planning or execution.');
  return `<div class="context-capsules">${capsules.map((capsule) => `<details class="context-capsule"><summary><span><strong>${escapeHtml(capsule.goal)}</strong><small>${escapeHtml(capsule.kind)} · ${capsule.estimatedTokens}/${capsule.tokenBudget} estimated tokens · ${escapeHtml(capsule.repositorySha.slice(0, 12))}</small></span><span class="badge">${capsule.provenance.graphNodeIds.length} nodes</span></summary><div class="context-capsule-body"><p class="settings-copy">${capsule.payload.files.length} source files · ${capsule.payload.symbols.length} symbols · ${capsule.payload.tests.length} tests · ${capsule.payload.projectRules.length} instruction files</p><dl class="settings-facts"><div><dt>Sources</dt><dd>${capsule.provenance.sourceFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join(', ') || 'No source file selected'}</dd></div><div><dt>Memory</dt><dd><code>${escapeHtml(capsule.memoryRevisionSha.slice(0, 12))}</code></dd></div><div><dt>Hash</dt><dd><code>${escapeHtml(capsule.contentHash.slice(0, 16))}</code></dd></div></dl></div></details>`).join('')}</div>`;
}

export async function initMemory(container, { project, api }) {
  let status;
  let capsules = [];
  try {
    [status, capsules] = await Promise.all([api.getMemoryStatus(project.id), api.listMemoryContexts(project.id)]);
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Memory unavailable', error.message)}</div>`;
    return;
  }
  container.innerHTML = `
    <div class="memory-grid">
      <article class="panel memory-status"><div class="panel-header"><div><p class="eyebrow">Local project intelligence</p><h2>Memory index</h2></div><span class="badge" id="memoryState">${escapeHtml(statusLabel(status))}</span></div><div class="panel-body"><dl class="settings-facts"><div><dt>Repository</dt><dd><code>${escapeHtml(status.repositorySha.slice(0, 12))}</code></dd></div><div><dt>Indexed</dt><dd>${status.indexedSha ? `<code>${escapeHtml(status.indexedSha.slice(0, 12))}</code>` : 'Not yet indexed'}</dd></div><div><dt>Graph</dt><dd>${status.counts.files} files · ${status.counts.symbols || 0} symbols · ${status.counts.edges} edges</dd></div><div><dt>Search</dt><dd>${status.counts.documents || 0} local documents</dd></div><div><dt>Quality</dt><dd>Level ${status.qualityLevel} · ${status.qualityLevel >= 3 ? 'hybrid retrieval' : status.qualityLevel >= 2 ? 'symbols + imports' : 'file graph'}</dd></div></dl><div class="button-row"><button class="button primary" id="refreshMemory">${status.stale ? 'Refresh memory' : 'Rebuild memory'}</button></div><p class="field-hint">Indexes remain local. Secrets, binary files, build output, and <code>.gateignore</code> paths are excluded.</p></div></article>
      <article class="panel"><div class="panel-header"><div><p class="eyebrow">Hybrid retrieval</p><h2>Search memory</h2></div></div><div class="panel-body"><form class="form-grid" id="memorySearchForm"><div class="field"><label for="memorySearch">Intent, file, module, or symbol</label><input id="memorySearch" autocomplete="off" placeholder="where provider cancellation is handled" maxlength="500"></div><button class="button" type="submit">Search</button></form><div id="memorySearchResults" class="memory-results">${emptyState('◇', 'Search the project graph', 'Exact graph matches are combined with local full-text source retrieval.')}</div></div></article>
      <article class="panel settings-wide"><div class="panel-header"><div><p class="eyebrow">Deterministic impact preview</p><h2>Impact</h2></div></div><div class="panel-body"><form class="form-grid memory-impact-form" id="memoryImpactForm"><div class="field"><label for="memoryImpact">Filename, module, or symbol</label><input id="memoryImpact" autocomplete="off" placeholder="provider streaming" maxlength="500"></div><button class="button" type="submit">Analyze impact</button></form><div id="memoryImpactResults" class="memory-results"><p class="settings-copy">Impact follows persisted import and symbol-reference edges to production dependents and tests. Results are deterministic repository facts.</p></div></div></article>
      <article class="panel settings-wide"><div class="panel-header"><div><p class="eyebrow">Context compiler</p><h2>Grounded capsules</h2></div></div><div class="panel-body"><form class="context-compiler-form" id="contextCompilerForm"><div class="field context-goal"><label for="contextGoal">Task goal</label><input id="contextGoal" autocomplete="off" placeholder="change provider cancellation behavior" minlength="3" maxlength="20000"></div><div class="field"><label for="contextKind">Use</label><select id="contextKind"><option value="context">Context</option><option value="planning">Planning</option><option value="execution">Execution</option></select></div><div class="field"><label for="contextBudget">Token budget</label><input id="contextBudget" type="number" min="512" max="32000" value="4000"></div><button class="button primary" type="submit">Compile context</button></form><p class="field-hint">Compilation requires a current Memory revision and persists exact source, graph, instruction, and commit provenance.</p><div id="contextCapsules" class="memory-results">${contextCapsules(capsules)}</div></div></article>
      <article class="panel settings-wide"><div class="panel-header"><div><p class="eyebrow">Graph-grounded answers</p><h2>Ask memory</h2></div></div><div class="panel-body"><form class="form-grid memory-impact-form" id="memoryAskForm"><div class="field"><label for="memoryAsk">Question about this codebase</label><input id="memoryAsk" autocomplete="off" placeholder="what depends on the provider adapter?" maxlength="2000"></div><button class="button" type="submit">Ask</button></form><div id="memoryAskResults" class="memory-results"><p class="settings-copy">Answers are assembled from indexed nodes and recorded edges only. Every claim cites a repository location; no relationship is inferred.</p></div></div></article>
      <article class="panel settings-wide"><div class="panel-header"><div><p class="eyebrow">Structural analysis</p><h2>Graph overview</h2></div><button class="button" id="loadGraphOverview">Load overview</button></div><div class="panel-body"><div id="memoryOverviewResults" class="memory-results"><p class="settings-copy">God nodes rank structural centrality; communities group code that imports or references each other.</p></div></div></article>
      <article class="panel settings-wide"><div class="panel-header"><div><p class="eyebrow">Recorded connections</p><h2>Path</h2></div></div><div class="panel-body"><form class="context-compiler-form" id="memoryPathForm"><div class="field"><label for="memoryPathFrom">From</label><input id="memoryPathFrom" autocomplete="off" placeholder="memory-service" maxlength="500"></div><div class="field"><label for="memoryPathTo">To</label><input id="memoryPathTo" autocomplete="off" placeholder="timeline-service" maxlength="500"></div><button class="button" type="submit">Find path</button></form><div id="memoryPathResults" class="memory-results"><p class="settings-copy">Each endpoint resolves through search; the hop sequence follows persisted edges only.</p></div></div></article>
      <article class="panel settings-wide"><div class="panel-header"><div><p class="eyebrow">Focused graph explorer</p><h2>Neighborhood</h2></div></div><div class="panel-body"><div class="memory-graph-controls"><label>Depth <select id="memoryGraphDepth"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select></label>${['CONTAINS', 'IMPORTS', 'REFERENCES'].map((type) => `<label><input type="checkbox" name="memoryEdgeType" value="${type}" checked> ${type}</label>`).join('')}</div><div id="memoryGraphResults" class="memory-results">${emptyState('◎', 'Select a memory result', 'The explorer loads only the selected node neighborhood and keeps a list fallback.')}</div></div></article>
    </div>`;

  let lastQuery = '';
  async function resolveNode(text) {
    const result = await api.searchMemory(project.id, text, { limit: 1 });
    if (!result.items.length) throw new Error(`No indexed node matches “${text}”`);
    return result.items[0];
  }
  async function showNeighbors(nodeId) {
    try {
      const depth = Number(container.querySelector('#memoryGraphDepth').value);
      const edgeTypes = [...container.querySelectorAll('[name="memoryEdgeType"]:checked')].map((input) => input.value);
      const [graph, explanation] = await Promise.all([
        api.getMemoryNeighbors(project.id, nodeId, { depth, edgeTypes }),
        api.explainMemoryNode(project.id, nodeId, lastQuery)
      ]);
      const target = container.querySelector('#memoryGraphResults');
      const related = graph.nodes.filter((node) => node.id !== graph.node.id);
      const edgeCounts = Object.entries(graph.edges.reduce((counts, edge) => ({ ...counts, [edge.type]: (counts[edge.type] || 0) + 1 }), {}));
      target.innerHTML = `<p class="settings-copy"><strong>${escapeHtml(nodeLabel(graph.node))}</strong> · ${related.length} related nodes · ${graph.edges.length} edges</p><p class="memory-reason">${escapeHtml(explanation.summary)}</p><div class="memory-edge-summary">${edgeCounts.map(([type, count]) => `<span class="badge">${escapeHtml(type)} ${count}</span>`).join('')}</div>${nodeList(related)}`;
      bindNodes(target);
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
    lastQuery = query;
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
      target.innerHTML = `<p class="settings-copy">Impact: <strong>${escapeHtml(result.risk.toUpperCase())}</strong> · ${result.edges.length} structural relationship${result.edges.length === 1 ? '' : 's'}</p>${impactSection('Direct matches', result.directMatches, result.reasons)}${impactSection('Declaring files', result.declaringFiles, result.reasons)}${impactSection('Production dependents', result.dependents, result.reasons)}${impactSection('Tests', result.tests, result.reasons)}`;
      bindNodes(target);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  container.querySelector('#memoryAskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = container.querySelector('#memoryAsk').value.trim();
    if (!question) return;
    lastQuery = question;
    try {
      const answer = await api.queryMemory(project.id, question);
      const target = container.querySelector('#memoryAskResults');
      target.innerHTML = `<p class="settings-copy">${escapeHtml(answer.answer)}</p><p class="field-hint">${answer.citations.length} cited node${answer.citations.length === 1 ? '' : 's'} · ${answer.edges.length} recorded edge${answer.edges.length === 1 ? '' : 's'} · ${answer.estimatedTokens}/${answer.tokenBudget} estimated tokens${answer.truncated ? ' · trimmed to budget' : ''}</p>${citationList(answer.citations)}`;
      bindNodes(target);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  container.querySelector('#loadGraphOverview').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const [central, grouped] = await Promise.all([api.getMemoryGodNodes(project.id, { limit: 15 }), api.getMemoryCommunities(project.id, { limit: 8 })]);
      const target = container.querySelector('#memoryOverviewResults');
      target.innerHTML = `${godNodes(central)}${communities(grouped)}`;
      bindNodes(target);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  container.querySelector('#memoryPathForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const from = container.querySelector('#memoryPathFrom').value.trim();
    const to = container.querySelector('#memoryPathTo').value.trim();
    if (!from || !to) return;
    const target = container.querySelector('#memoryPathResults');
    try {
      const [start, end] = await Promise.all([resolveNode(from), resolveNode(to)]);
      const found = await api.getMemoryPath(project.id, start.id, end.id);
      target.innerHTML = `<p class="settings-copy">${found.hops} hop${found.hops === 1 ? '' : 's'} from <code>${escapeHtml(nodeLabel(found.from))}</code> to <code>${escapeHtml(nodeLabel(found.to))}</code></p><div class="memory-edge-summary">${found.edges.map((edge) => `<span class="badge">${escapeHtml(edge.type)}</span>`).join('')}</div>${nodeList(found.nodes)}`;
      bindNodes(target);
    } catch (error) {
      target.innerHTML = `<p class="settings-copy">${escapeHtml(error.message)}</p>`;
      showToast(error.message, 'error');
    }
  });
  container.querySelector('#contextCompilerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const goal = container.querySelector('#contextGoal').value.trim();
    if (!goal) return;
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      await api.compileMemoryContext(project.id, {
        goal,
        kind: container.querySelector('#contextKind').value,
        tokenBudget: Number(container.querySelector('#contextBudget').value)
      });
      capsules = await api.listMemoryContexts(project.id);
      container.querySelector('#contextCapsules').innerHTML = contextCapsules(capsules);
      showToast('Grounded context capsule compiled');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}
