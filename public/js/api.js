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
  getTimeline: (projectId) => request(`/projects/${projectId}/timeline`),
  replaceTimeline: (projectId, graph) => request(`/projects/${projectId}/timeline`, { method: 'PUT', body: graph }),
  draftTimeline: (projectId, goal) => request(`/projects/${projectId}/timeline/drafts`, { method: 'POST', body: { goal } }),
  acceptTimelineDraft: (projectId, draftId) => request(`/projects/${projectId}/timeline/drafts/${draftId}/accept`, { method: 'POST', body: {} }),
  startStep: (projectId, nodeId) => request(`/projects/${projectId}/runs`, { method: 'POST', body: { nodeId } }),
  schedule: (projectId) => request(`/projects/${projectId}/runs/schedule`, { method: 'POST', body: {} }),
  cancelRun: (runId) => request(`/runs/${runId}/cancel`, { method: 'POST', body: {} }),
  getRuns: (projectId) => request(`/projects/${projectId}/runs`),
  getReview: (projectId) => request(`/projects/${projectId}/review`),
  getDashboard: (projectId) => request(`/projects/${projectId}/dashboard`)
};
