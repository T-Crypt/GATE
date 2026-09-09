export class ApiError extends Error {
  constructor(error, status) {
    super(error?.message || 'Request failed');
    this.name = 'ApiError';
    this.code = error?.code || 'REQUEST_FAILED';
    this.status = status;
    this.requestId = error?.requestId;
    this.details = error?.details;
  }
}

function idempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random()}`;
}

export async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method) && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', idempotencyKey());
  }
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error, response.status);
  return payload.data;
}

export const api = {
  listProjects: () => request('/projects'),
  createProject: (input) => request('/projects', { method: 'POST', body: input }),
  updatePolicy: (projectId, input) => request(`/projects/${projectId}/policy`, { method: 'PATCH', body: input }),
  updateProvider: (projectId, input) => request(`/projects/${projectId}/provider`, { method: 'PATCH', body: input }),
  getTimeline: (projectId) => request(`/projects/${projectId}/timeline`),
  replaceTimeline: (projectId, graph) => request(`/projects/${projectId}/timeline`, { method: 'PUT', body: graph }),
  draftTimeline: (projectId, goal, model) => request(`/projects/${projectId}/timeline/drafts`, { method: 'POST', body: { goal, ...(model ? { model } : {}) } }),
  acceptTimelineDraft: (projectId, draftId) => request(`/projects/${projectId}/timeline/drafts/${draftId}/accept`, { method: 'POST', body: {} }),
  startStep: (projectId, nodeId) => request(`/projects/${projectId}/runs`, { method: 'POST', body: { nodeId } }),
  schedule: (projectId) => request(`/projects/${projectId}/runs/schedule`, { method: 'POST', body: {} }),
  cancelRun: (runId) => request(`/runs/${runId}/cancel`, { method: 'POST', body: {} }),
  getRuns: (projectId) => request(`/projects/${projectId}/runs`),
  getActivityFeed: (projectId) => request(`/projects/${projectId}/activity`),
  getReview: (projectId) => request(`/projects/${projectId}/review`),
  submitEvidence: (projectId, gateId, input) => request(`/projects/${projectId}/gates/${gateId}/evidence`, { method: 'POST', body: input }),
  decideGate: (projectId, gateId, input) => request(`/projects/${projectId}/gates/${gateId}/decisions`, { method: 'POST', body: input }),
  getDashboard: (projectId) => request(`/projects/${projectId}/dashboard`),
  addIssue: (projectId, input) => request(`/projects/${projectId}/issues`, { method: 'POST', body: input }),
  updateIssue: (projectId, issueId, input) => request(`/projects/${projectId}/issues/${issueId}`, { method: 'PATCH', body: input }),
  addNote: (projectId, input) => request(`/projects/${projectId}/notes`, { method: 'POST', body: input }),
  syncGit: (projectId) => request(`/projects/${projectId}/git/sync`, { method: 'POST', body: {} })
};
