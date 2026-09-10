import { emptyState, escapeHtml } from './components.js';

function metric(label, value, tone = '') {
  return `<article class="panel metric ${tone}"><span class="metric-label">${escapeHtml(label)}</span><strong class="metric-value">${escapeHtml(value)}</strong></article>`;
}

function strip(id, eyebrow, title, rows, viewAllRoute) {
  return `
    <article class="panel" id="${id}">
      <div class="panel-header"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2></div></div>
      <div class="panel-body">
        <div class="summary-strip-list">${rows}</div>
        <a class="view-all-link" href="#/${viewAllRoute}">View all &rarr;</a>
      </div>
    </article>`;
}

export async function initOverview(container, { project, api }) {
  container.innerHTML = '<div class="timeline-loading"><div class="loading-orbit"></div>Loading local project signal…</div>';
  try {
    const [model, remoteStatus, prs, inbox] = await Promise.all([
      api.getDashboard(project.id),
      api.getRemoteStatus(project.id).catch(() => ({ configured: false, prCount: 0 })),
      api.getRemotePrs(project.id).catch(() => []),
      api.getInbox(project.id).catch(() => ({ items: [] }))
    ]);
    const { metrics = {}, issues = [], notes = [], gitEvents = [] } = model;

    const issueRows = issues.slice(0, 4).map((issue) =>
      `<div class="summary-strip-row"><span class="status-dot ${escapeHtml(issue.status)}"></span><strong>${escapeHtml(issue.title)}</strong></div>`
    ).join('') || '<p class="muted-copy">No issues yet.</p>';

    const commitRows = gitEvents.slice(0, 4).map((commit) =>
      `<div class="summary-strip-row"><code>${escapeHtml(commit.commit_hash.slice(0, 8))}</code><strong>${escapeHtml(commit.message)}</strong></div>`
    ).join('') || '<p class="muted-copy">No cached commits.</p>';

    const noteRows = notes.slice(0, 3).map((note) =>
      `<div class="summary-strip-row"><span class="status-dot"></span><strong>${escapeHtml(note.body)}</strong></div>`
    ).join('') || '<p class="muted-copy">No notes yet.</p>';

    const inboxRows = inbox.items.slice(0, 4).map((item) =>
      `<div class="summary-strip-row"><span class="status-dot ${item.kind === 'plan_stale' || item.kind === 'run_failed' ? 'failed' : 'review'}"></span><strong>${escapeHtml(item.title)}</strong></div>`
    ).join('') || '<p class="muted-copy">Nothing is waiting on you.</p>';

    const prRows = prs.slice(0, 4).map((pr) =>
      `<div class="summary-strip-row"><span class="status-dot clean"></span><span class="pr-ref">#${pr.number}</span><strong>${escapeHtml(pr.title)}</strong><code>${escapeHtml(pr.headRef)}</code></div>`
    ).join('') || (remoteStatus.configured ? '<p class="muted-copy">No open pull requests.</p>' : '<p class="muted-copy">Remote not configured. Set GATE_GITHUB_TOKEN to see PRs.</p>');

    container.innerHTML = `
      <div class="placeholder-grid dashboard-metrics">
        ${metric('Active runs', metrics.activeRuns || 0, 'cyan')}
        ${metric('Blocked gates', metrics.blockedGates || 0, metrics.blockedGates ? 'amber' : '')}
        ${metric('Review queue', metrics.reviewQueue || 0, metrics.reviewQueue ? 'violet' : '')}
        ${metric('Open issues', metrics.openIssues || 0)}
        ${metric('Open PRs', remoteStatus.prCount || 0, remoteStatus.configured ? '' : 'muted')}
        ${metric('Inbox', inbox.items.length, inbox.items.length ? 'amber' : '')}
      </div>
      <div class="summary-grid">
        ${strip('overviewInbox', 'Needs a human decision', 'Planning inbox', inboxRows, 'inbox')}
        ${strip('overviewPrs', 'GitHub · read only', 'Recent pull requests', prRows, 'git')}
        ${strip('overviewIssues', 'Local tracker', 'Recent issues', issueRows, 'issues')}
        ${strip('overviewGit', 'Observed only', 'Recent commits', commitRows, 'git')}
        ${strip('overviewNotes', 'Project memory', 'Recent notes', noteRows, 'issues')}
      </div>`;
  } catch (error) {
    container.innerHTML = `<div class="panel">${emptyState('!', 'Overview unavailable', error.message)}</div>`;
  }
}
