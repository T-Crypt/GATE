import { emptyState, escapeHtml, showToast } from './components.js';

function statusStrip(gitStatus) {
  const { branch, headSha, dirty } = gitStatus || {};
  if (!branch) return '';
  return `
    <div class="git-status-strip">
      <span class="status-dot ${dirty ? 'dirty' : 'clean'}"></span>
      <span>branch</span><strong>${escapeHtml(branch)}</strong>
      <span>head</span><strong>${escapeHtml((headSha || '').slice(0, 8))}</strong>
      <span>${dirty ? 'uncommitted changes' : 'clean'}</span>
    </div>`;
}

function changedFilesList(changedFiles) {
  if (!changedFiles?.length) return '';
  return `
    <div class="changed-files-list">
      ${changedFiles.map((path) => `<div class="changed-file-row">${escapeHtml(path)}</div>`).join('')}
    </div>`;
}

function commitRail(gitEvents) {
  if (!gitEvents.length) return emptyState('GT', 'No cached commits', 'Sync reads local Git history. It never pushes or changes a branch.');
  return `
    <div class="rail-track">
      ${gitEvents.slice(0, 20).map((commit) => `
        <div class="rail-row">
          <code>${escapeHtml(commit.commit_hash.slice(0, 8))}</code>
          <strong>${escapeHtml(commit.message)}</strong>
          <small>${escapeHtml(commit.author || 'unknown')} · ${escapeHtml(commit.committed_at || '')}</small>
        </div>`).join('')}
    </div>`;
}

export async function initGit(container, { project, api }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading local project signal…</div>';
  try {
    const model = await api.getDashboard(project.id);
    const { gitEvents = [], gitStatus, changedFiles = [] } = model;
    container.innerHTML = `
      <article class="panel" id="gitPanel">
        <div class="panel-header"><div><p class="eyebrow">Observed only</p><h2>Repository status</h2></div><button class="button" id="syncGit">Sync ${escapeHtml(project.baseBranch)}</button></div>
        <div class="panel-body">
          ${statusStrip(gitStatus)}
          ${changedFilesList(changedFiles)}
        </div>
      </article>
      <article class="panel" id="commitHistoryPanel">
        <div class="panel-header"><div><p class="eyebrow">History</p><h2>Commits</h2></div></div>
        <div class="panel-body">${commitRail(gitEvents)}</div>
      </article>`;

    container.querySelector('#syncGit')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      await api.syncGit(project.id);
      showToast('Local Git history refreshed');
      await initGit(container, { project, api });
    });
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Git status unavailable', error.message)}</div>`;
  }
}
