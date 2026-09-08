import { initDashboard } from './dashboard.js';
import { initAgent } from './agent.js';
import { initTimeline } from './timeline.js';

export const state = {
  projectId: null
};

async function loadProjects() {
  const res = await fetch('/api/projects');
  const projects = await res.json();
  const select = document.getElementById('projectSelect');
  select.innerHTML = '';

  if (projects.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No projects — add one below';
    select.appendChild(opt);
    promptCreateProject();
    return;
  }

  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }

  state.projectId = projects[0].id;
  select.value = state.projectId;
  select.addEventListener('change', () => {
    state.projectId = Number(select.value);
    refreshActiveTab();
  });

  refreshActiveTab();
}

async function promptCreateProject() {
  const name = prompt('Project name:');
  if (!name) return;
  const repo_path = prompt('Absolute path to git repo on this machine:');
  if (!repo_path) return;
  const agent_cmd = prompt('CLI command to drive the agent (default: claude):', 'claude');

  await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, repo_path, agent_cmd })
  });
  loadProjects();
}

function setupTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      refreshActiveTab();
    });
  });
}

function refreshActiveTab() {
  if (!state.projectId) return;
  const active = document.querySelector('.tab-btn.active').dataset.tab;
  if (active === 'dashboard') initDashboard(state.projectId);
  if (active === 'agent') initAgent(state.projectId);
  if (active === 'timeline') initTimeline(state.projectId);
}

setupTabs();
loadProjects();
