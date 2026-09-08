const listeners = new Set();
const state = {
  projects: [],
  projectId: null,
  route: 'overview',
  connection: 'offline',
  lastSequence: 0,
  events: []
};

function emit() {
  const snapshot = getState();
  for (const listener of listeners) listener(snapshot);
}

export function getState() {
  return { ...state, projects: [...state.projects], events: [...state.events] };
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateState(patch) {
  Object.assign(state, patch);
  emit();
}

export function setProject(projectId) {
  state.projectId = Number(projectId);
  state.lastSequence = 0;
  state.events = [];
  localStorage.setItem('gate.projectId', String(projectId));
  emit();
}

export function setRoute(route) {
  state.route = route;
  emit();
}

export function applyEvent(message) {
  if (message.sequence <= state.lastSequence) return;
  state.lastSequence = message.sequence;
  state.events = [...state.events.slice(-199), message.event];
  emit();
}
