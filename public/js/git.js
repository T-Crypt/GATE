import { emptyState, escapeHtml, showToast } from './components.js';

function statusStrip(gitStatus, remoteConfigured) {
  const { branch, headSha, dirty } = gitStatus || {};
  if (!branch) return '';
  const remoteDot = remoteConfigured ? '<span class="status-dot clean"></span>' : '<span class="status-dot muted"></span>';
  return `
    <div class="git-status-strip">
      <span class="status-dot ${dirty ? 'dirty' : 'clean'}"></span>
      <span>branch</span><strong>${escapeHtml(branch)}</strong>
      <span>head</span><strong>${escapeHtml((headSha || '').slice(0, 8))}</strong>
      <span>${dirty ? 'uncommitted changes' : 'clean'}</span>
      ${remoteConfigured ? '<span class="status-dot clean"></span><span>remote connected</span>' : '<span class="status-dot muted"></span><span>remote not configured</span>'}
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
      ${gitEvents.slice(0, 30).map((commit) => `
        <div class="rail-row">
          <code>${escapeHtml(commit.commit_hash.slice(0, 8))}</code>
          <strong>${escapeHtml(commit.message)}</strong>
          <small>${escapeHtml(commit.author || 'unknown')} · ${escapeHtml(commit.committed_at || '')}</small>
        </div>`).join('')}
    </div>`;
}

function branchList(localBranches) {
  if (!localBranches?.length) return emptyState('BR', 'No local branches', 'None found on this repository.');
  return `
    <div class="branch-list">
      ${localBranches.map((branch) => `<div class="branch-row"><code>${escapeHtml(branch)}</code></div>`).join('')}
    </div>`;
}

function pullRequestList(prs) {
  if (!prs.length) return '<p class="muted-copy">No open pull requests.</p>';
  return `
    <div class="record-list">
      ${prs.map((pr) => `
        <div class="issue-card" data-pr="${pr.number}">
          <div class="issue-card-head"><strong>${escapeHtml(pr.title)}</strong>${pr.draft ? '<span class="badge">draft</span>' : ''}</div>
          <div class="issue-card-sub">
            <span class="pr-ref">#${pr.number}</span>
            <code>${escapeHtml(pr.headRef)}</code> &rarr; <code>${escapeHtml(pr.baseRef)}</code>
            <small>${escapeHtml(pr.author || 'unknown')} · ${escapeHtml(pr.updatedAt || '')}</small>
          </div>
        </div>`).join('')}
    </div>`;
}

function remoteIssueList(issues) {
  if (!issues.length) return '<p class="muted-copy">No open issues on the repository.</p>';
  return `
    <div class="record-list">
      ${issues.map((issue) => `
        <div class="issue-card" data-issue="${issue.number}">
          <div class="issue-card-head"><strong>${escapeHtml(issue.title)}</strong><span class="pr-ref">#${issue.number}</span></div>
          <div class="issue-card-sub">
            ${issue.labels.map((label) => `<span class="badge">${escapeHtml(label)}</span>`).join('')}
            <small>${escapeHtml(issue.assignee || 'unassigned')} · ${escapeHtml(issue.updatedAt || '')}</small>
          </div>
        </div>`).join('')}
    </div>`;
}

export async function initGit(container, { project, api }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading local project signal…</div>';
  try {
    const [model, remoteStatus, prs, remoteIssues, localBranches] = await Promise.all([
      api.getDashboard(project.id),
      api.getRemoteStatus(project.id).catch(() => ({ configured: false, prCount: 0, issueCount: 0 })),
      api.getRemotePrs(project.id).catch(() => []),
      api.getRemoteIssues(project.id).catch(() => []),
      api.getBranches(project.id).catch(() => [])
    ]);
    const { gitEvents = [], gitStatus, changedFiles = [] } = model;
    const remoteConfigured = Boolean(remoteStatus.configured);
    container.innerHTML = `
      <article class="panel" id="gitPanel">
        <div class="panel-header"><div><p class="eyebrow">Observed only</p><h2>Repository status</h2></div><div class="button-row"><button class="button" id="syncRemote" ${remoteConfigured ? '' : 'title="Set GATE_GITHUB_TOKEN to enable remote observation"'}>Sync remote</button><button class="button" id="syncGit">Sync ${escapeHtml(project.baseBranch)}</button></div></div>
        <div class="panel-body">
          ${statusStrip(gitStatus, remoteConfigured)}
          ${changedFilesList(changedFiles)}
        </div>
      </article>
      <article class="panel" id="prPanel">
        <div class="panel-header"><div><p class="eyebrow">Remote · read only</p><h2>Pull requests</h2></div>${remoteConfigured ? `<span class="badge">${prs.length} open</span>` : '<span class="badge">not configured</span>'}</div>
        <div class="panel-body">${remoteConfigured ? pullRequestList(prs) : emptyState('PR', 'Remote observation off', 'Set GATE_GITHUB_TOKEN in a .env file or as an environment variable, then press "Sync remote". Gate reads open PRs without ever creating, merging, or pushing a branch.')}</div>
      </article>
      <article class="panel" id="remoteIssuesPanel">
        <div class="panel-header"><div><p class="eyebrow">Remote · read only</p><h2>Repository issues</h2></div>${remoteConfigured ? `<span class="badge">${remoteIssues.length} open</span>` : '<span class="badge">not configured</span>'}</div>
        <div class="panel-body">${remoteConfigured ? remoteIssueList(remoteIssues) : emptyState('RI', 'No remote issues cached', 'Open issues on the repository appear here once the remote is configured and synced.')}</div>
      </article>
      <article class="panel" id="localBranchesPanel">
        <div class="panel-header"><div><p class="eyebrow">Local refs</p><h2>Branches</h2></div></div>
        <div class="panel-body">${branchList(localBranches)}</div>
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
    container.querySelector('#syncRemote')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        await api.syncRemote(project.id);
        showToast('Remote PRs and issues refreshed');
      } catch (error) {
        showToast(error.message, 'error');
      }
      await initGit(container, { project, api });
    });
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Git status unavailable', error.message)}</div>`;
  }
}
