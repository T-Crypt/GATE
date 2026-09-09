import { api } from './api.js';
import { appendLiveActivity, initAgent, renderActivityRail } from './agent.js';
import { initActivity } from './activity.js';
import { emptyState, escapeHtml, openDialog, showToast } from './components.js';
import { initGit } from './git.js';
import { initIssues } from './issues.js';
import { initMemory } from './memory.js';
import { initOverview } from './overview.js';
import { initReviews } from './reviews.js';
import { initSettings } from './settings.js';
import { providerName } from './components.js';
import { applyEvent, getState, setProject, setRoute, updateState } from './state.js';
import { initTimeline } from './timeline.js';
import { applyAccent, getAccent } from './theme.js';

applyAccent(getAccent());

const app = document.getElementById('app');
let socket = null;
let reconnectTimer = null;

const routes = [
  ['overview', 'OV', 'Overview'],
  ['timeline', 'TL', 'Timeline'],
  ['memory', 'MM', 'Memory'],
  ['agent', 'AI', 'Agent'],
  ['activity', 'AC', 'Activity'],
  ['issues', 'IS', 'Issues'],
  ['git', 'GT', 'Git'],
  ['reviews', 'RV', 'Reviews'],
  ['settings', 'ST', 'Settings']
];

function activeProject(state = getState()) {
  return state.projects.find((project) => project.id === state.projectId) || state.projects[0] || null;
}

function routeFromHash() {
  const route = location.hash.replace(/^#\/?/, '').split('/')[0] || 'overview';
  return routes.some(([name]) => name === route) ? route : 'overview';
}

function renderShell() {
  const state = getState();
  const project = activeProject(state);
  app.innerHTML = `
    <div class="workstation">
      <header class="topbar">
        <div class="brand-wrap"><span class="brand-mark" aria-hidden="true">GT</span><span class="brand-name">Gate<small>local control plane</small></span></div>
        <div class="project-bar">
          <button class="nav-toggle" id="navToggle" aria-label="Open navigation">☰</button>
          <label class="sr-only" for="projectSelect">Active project</label>
          <select id="projectSelect" class="project-select" ${state.projects.length ? '' : 'disabled'}>
            ${state.projects.length ? state.projects.map((item) => `<option value="${item.id}" ${item.id === state.projectId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('') : '<option>No projects</option>'}
          </select>
          <button class="icon-button" id="addProjectButton" aria-label="Connect another project" title="Connect another project">+</button>
          ${project ? `<span class="branch-pill">${escapeHtml(project.baseBranch)}</span><span class="mode-pill">${escapeHtml(project.stage || 'active')}</span><span class="mode-pill">${escapeHtml(project.interactionLevel)}</span>` : ''}
        </div>
        <div class="system-bar"><span class="connection-pill" id="connectionPill" data-state="${state.connection}">${escapeHtml(state.connection)}</span><button class="icon-button" id="commandButton" aria-label="Open command palette">⌘</button></div>
      </header>
      <aside class="sidebar" id="sidebar">
        <p class="nav-label">Workspace</p>
        <nav aria-label="Workspace"><ul class="nav-list">${routes.map(([route, icon, label]) => `<li><a class="nav-link ${state.route === route ? 'active' : ''}" href="#/${route}"><span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span>${route === 'reviews' ? '<span class="nav-count">0</span>' : ''}</a></li>`).join('')}</ul></nav>
        <div class="sidebar-footer"><strong>Human review required</strong><p>Protected branches cannot be changed or integrated by automatic runs.</p></div>
      </aside>
      <main class="workspace-main" id="workspace"></main>
      <aside class="activity-rail" aria-label="Agent activity"><div class="activity-head"><h2>Agent activity</h2><p>Live intent, evidence, and blockers</p></div><div class="activity-body" id="activityBody"><div class="activity-empty">No agent run is active.</div><div class="rail-card"><strong>Safety boundary</strong><p>${project ? `Runs branch from ${escapeHtml(project.baseBranch)} into an isolated worktree.` : 'Connect a project to configure branch protection.'}</p></div></div></aside>
    </div>`;
  bindShell();
  renderView();
  refreshActivity();
}

function bindShell() {
  document.getElementById('projectSelect')?.addEventListener('change', (event) => {
    setProject(event.target.value);
    connectLiveEvents();
    renderShell();
  });
  document.getElementById('addProjectButton')?.addEventListener('click', openOnboarding);
  document.getElementById('navToggle')?.addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
  document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', () => document.getElementById('sidebar').classList.remove('open')));
  document.getElementById('commandButton')?.addEventListener('click', openCommandPalette);
}

function viewHeader(eyebrow, title, description, actions = '') {
  return `<header class="view-header"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(description)}</p></div>${actions ? `<div class="button-row">${actions}</div>` : ''}</header>`;
}

function renderView() {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  const state = getState();
  if (!activeProject(state)) {
    workspace.innerHTML = `<section class="view">${viewHeader('Local workstation', 'Welcome to Gate', 'Connect a Git repository to begin planning and reviewing AI development.')}<div class="panel">${emptyState('＋', 'No project connected', 'Your repositories stay local. Gate creates isolated worktrees for automatic runs.', '<button class="button primary" id="connectEmpty">Connect project</button>')}</div></section>`;
    document.getElementById('connectEmpty')?.addEventListener('click', openOnboarding);
    return;
  }
  const definitions = {
    overview: ['Project signal', 'Project overview', 'Execution, review, and repository health at a glance.'],
    timeline: ['Guided execution', 'Interactive timeline', 'Milestones, dependencies, code gates, visual gates, and approvals.'],
    memory: ['Project intelligence', 'Memory', 'Local file graph, repository revision, and deterministic impact previews.'],
    agent: [providerName(activeProject(state).providerKind), 'Agent control', 'Observe current intent, streamed output, and bounded execution.'],
    activity: ['Run history', 'Activity', 'Every timeline-driven run against this project, with status and output.'],
    issues: ['Local tracking', 'Issues', 'Small work items linked to branches and timeline context.'],
    git: ['Repository', 'Git activity', 'Commits, branches, and changes observed from this local project.'],
    reviews: ['Human gate', 'Review center', 'Diffs, test evidence, screenshots, decisions, and approvals.'],
    settings: ['Project policy', 'Settings', 'Provider, interaction level, branch safety, and local storage.']
  };
  const [eyebrow, title, description] = definitions[state.route];
  workspace.innerHTML = `<section class="view">${viewHeader(eyebrow, title, description)}<div id="viewContent"></div></section>`;
  const content = workspace.querySelector('#viewContent');
  const project = activeProject(state);
  if (state.route === 'timeline') {
    void initTimeline(content, { project, api, onRunChanged: async () => refreshActivity() });
  } else if (state.route === 'memory') {
    void initMemory(content, { project, api });
  } else if (state.route === 'agent') {
    void initAgent(content, { project, api });
  } else if (state.route === 'activity') {
    void initActivity(content, { project, api });
  } else if (state.route === 'reviews') {
    void initReviews(content, { project, api });
  } else if (state.route === 'settings') {
    initSettings(content, { project, api, onProjectChanged: (updated) => {
      updateState({ projects: getState().projects.map((item) => item.id === updated.id ? updated : item) });
      renderShell();
    } });
  } else if (state.route === 'overview') {
    void initOverview(content, { project, api });
  } else if (state.route === 'issues') {
    void initIssues(content, { project, api });
  } else if (state.route === 'git') {
    void initGit(content, { project, api });
  } else {
    content.innerHTML = `<div class="placeholder-grid"><article class="panel metric"><span class="metric-label">Active runs</span><strong class="metric-value">0</strong></article><article class="panel metric"><span class="metric-label">Blocked gates</span><strong class="metric-value">0</strong></article><article class="panel metric"><span class="metric-label">Review queue</span><strong class="metric-value">0</strong></article></div><div class="panel workstation-placeholder">${emptyState('◇', `${title} is ready`, 'The workstation shell is connected. Detailed controls load in this workspace.')}</div>`;
  }
}

async function refreshActivity() {
  const container = document.getElementById('activityBody');
  const project = activeProject();
  if (container && project) await renderActivityRail(container, { project, api });
}

function openOnboarding() {
  const hasProjects = getState().projects.length;
  const label = hasProjects ? 'Connect a project' : 'Connect your first project';
  openDialog({
    label,
    content: `<div class="dialog-header"><p class="eyebrow">Local Git workspace</p><h2>${escapeHtml(label)}</h2><p>Gate detects your repository's default branch as the only protected branch and opens isolated worktrees for every automatic run.</p></div><form class="dialog-body form-grid" id="projectForm"><div class="field"><label for="projectName">Project name</label><input id="projectName" name="name" autocomplete="off" required maxlength="120" placeholder="Aphotic workstation" /></div><div class="field"><label for="projectStage">Project stage</label><select id="projectStage" name="stage"><option value="active">Active Development</option><option value="greenfield">New Project</option><option value="maintenance">Maintenance / Production</option></select><span class="field-hint">Stage changes planning emphasis; every stage retains human gates and protected-branch controls.</span></div><div class="field"><label for="repoPath">Repository path</label><input id="repoPath" name="repoPath" autocomplete="off" required placeholder="/home/you/project" /><span class="field-hint">Absolute path to an existing local Git repository. The default branch is detected automatically.</span></div><div class="field" id="baseBranchField" hidden><label for="baseBranch">Default branch</label><input id="baseBranch" name="baseBranch" value="main" readonly /></div><div class="field" id="baseBranchDetect"><span class="field-hint" id="baseBranchDetectText">Enter a repository path to detect its default branch.</span></div><div class="field"><label for="branchPrefix">Branch naming prefix</label><input id="branchPrefix" name="branchPrefix" value="work/gate-" maxlength="250" /><span class="field-hint">Every run opens an isolated branch with this prefix, e.g. <code>work/gate-&lt;run&gt;</code>.</span></div><p class="form-error" id="projectError" role="alert"></p><div class="button-row"><button class="button primary" type="submit">Connect project</button></div></form>`,
    onMount(dialog) {
      const form = dialog.querySelector('#projectForm');
      const repoPathInput = dialog.querySelector('#repoPath');
      const baseField = dialog.querySelector('#baseBranchField');
      const baseDetect = dialog.querySelector('#baseBranchDetect');
      const baseDetectText = dialog.querySelector('#baseBranchDetectText');
      const baseInput = dialog.querySelector('#baseBranch');
      let detectTimer = null;
      repoPathInput.addEventListener('input', () => {
        clearTimeout(detectTimer);
        detectTimer = setTimeout(async () => {
          const pathValue = repoPathInput.value.trim();
          if (!pathValue) {
            baseField.hidden = true;
            baseDetect.hidden = false;
            baseDetectText.textContent = 'Enter a repository path to detect its default branch.';
            return;
          }
          try {
            const result = await api.inspectRepo({ repoPath: pathValue });
            baseInput.value = result.defaultBranch || 'main';
            baseField.hidden = false;
            baseDetect.hidden = true;
          } catch {
            baseField.hidden = true;
            baseDetect.hidden = false;
            baseDetectText.textContent = 'Could not detect a default branch for that path.';
          }
        }, 400);
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const project = await api.createProject(values);
          void api.refreshMemory(project.id, { force: true }).catch(() => undefined);
          const projects = await api.listProjects();
          updateState({ projects, projectId: project.id });
          dialog.close();
          renderShell();
          connectLiveEvents();
          showToast(`${project.name} connected`);
        } catch (error) {
          form.querySelector('#projectError').textContent = error.message;
          button.disabled = false;
        }
      });
    }
  });
}

function openCommandPalette() {
  const commands = routes.map(([route, icon, label]) => ({ route, icon, label: `Open ${label.toLowerCase()}` }));
  openDialog({
    label: 'Command palette',
    className: 'command-dialog',
    content: `<label class="sr-only" for="commandSearch">Search commands</label><input id="commandSearch" class="command-search" placeholder="Type a command…" autocomplete="off" /><ul class="command-list" role="listbox">${commands.map((command, index) => `<li><button class="command-item" role="option" aria-selected="${index === 0}" data-route="${command.route}"><span class="nav-icon">${command.icon}</span>${escapeHtml(command.label)}<span class="command-key">↵</span></button></li>`).join('')}</ul>`,
    onMount(dialog) {
      const search = dialog.querySelector('#commandSearch');
      const items = [...dialog.querySelectorAll('.command-item')];
      items.forEach((item) => item.addEventListener('click', () => { location.hash = `#/${item.dataset.route}`; dialog.close(); }));
      search.addEventListener('input', () => {
        const query = search.value.toLowerCase();
        items.forEach((item) => { item.closest('li').hidden = !item.textContent.toLowerCase().includes(query); });
      });
      search.focus();
    }
  });
}

function connectLiveEvents() {
  clearTimeout(reconnectTimer);
  socket?.close();
  const state = getState();
  if (!state.projectId) return;
  updateState({ connection: 'connecting' });
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/ws?projectId=${state.projectId}&after=${state.lastSequence}`);
  socket.addEventListener('open', () => updateConnection('connected'));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'event') {
      applyEvent(message);
      if (getState().route === 'timeline') renderView();
      void refreshActivity();
    }
    if (message.type === 'activity') {
      appendLiveActivity(document.getElementById('activityBody'), message.activity);
    }
  });
  socket.addEventListener('close', () => {
    updateConnection('offline');
    reconnectTimer = setTimeout(() => {
      if (getState().projectId === state.projectId) connectLiveEvents();
    }, 1800);
  });
}

function updateConnection(connection) {
  updateState({ connection });
  const pill = document.getElementById('connectionPill');
  if (pill) { pill.dataset.state = connection; pill.textContent = connection; }
}

window.addEventListener('hashchange', () => { setRoute(routeFromHash()); renderShell(); });
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openCommandPalette();
  }
});

async function bootstrap() {
  app.innerHTML = '<div class="loading-screen"><div class="loading-mark"><div class="loading-orbit"></div><span>Opening local control plane…</span></div></div>';
  try {
    const projects = await api.listProjects();
    const remembered = Number(localStorage.getItem('gate.projectId'));
    const selected = projects.find((project) => project.id === remembered)?.id || projects[0]?.id || null;
    updateState({ projects, projectId: selected, route: routeFromHash() });
    renderShell();
    if (selected) connectLiveEvents();
    else openOnboarding();
  } catch (error) {
    app.innerHTML = `<div class="loading-screen"><div class="empty-state"><div><div class="empty-state-mark">!</div><h1>Gate could not start</h1><p>${escapeHtml(error.message)}</p></div></div></div>`;
  }
}

bootstrap();
