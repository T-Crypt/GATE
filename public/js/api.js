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
  inspectRepo: (input) => request('/projects/inspect', { method: 'POST', body: input }),
  updatePolicy: (projectId, input) => request(`/projects/${projectId}/policy`, { method: 'PATCH', body: input }),
  updateProvider: (projectId, input) => request(`/projects/${projectId}/provider`, { method: 'PATCH', body: input }),
  listProviderModels: (kind) => request(`/providers/${encodeURIComponent(kind)}/models`),
  updateStage: (projectId, input) => request(`/projects/${projectId}/stage`, { method: 'PATCH', body: input }),
  listInstructions: (projectId) => request(`/projects/${projectId}/instructions`),
  getInstruction: (projectId, fileName) => request(`/projects/${projectId}/instructions/${encodeURIComponent(fileName)}`),
  updateInstruction: (projectId, fileName, input) => request(`/projects/${projectId}/instructions/${encodeURIComponent(fileName)}`, { method: 'PUT', body: input }),
  getMemoryStatus: (projectId) => request(`/projects/${projectId}/memory/status`),
  refreshMemory: (projectId, input = {}) => request(`/projects/${projectId}/memory/refresh`, { method: 'POST', body: input }),
  searchMemory: (projectId, query, input = {}) => request(`/projects/${projectId}/memory/search?${new URLSearchParams({ q: query, ...input })}`),
  getMemoryNeighbors: (projectId, nodeId, input = {}) => {
    const options = typeof input === 'number' ? { depth: input } : input;
    const query = new URLSearchParams({ depth: options.depth || 1 });
    if (options.edgeTypes?.length) query.set('edgeTypes', options.edgeTypes.join(','));
    return request(`/projects/${projectId}/memory/nodes/${encodeURIComponent(nodeId)}/neighbors?${query}`);
  },
  getMemoryImpact: (projectId, query) => request(`/projects/${projectId}/memory/impact?${new URLSearchParams({ q: query })}`),
  explainMemoryNode: (projectId, nodeId, query) => request(`/projects/${projectId}/memory/nodes/${encodeURIComponent(nodeId)}/explain?${new URLSearchParams(query ? { q: query } : {})}`),
  getMemoryGodNodes: (projectId, input = {}) => request(`/projects/${projectId}/memory/god-nodes?${new URLSearchParams(input)}`),
  getMemoryCommunities: (projectId, input = {}) => request(`/projects/${projectId}/memory/communities?${new URLSearchParams(input)}`),
  getMemoryPath: (projectId, from, to) => request(`/projects/${projectId}/memory/path?${new URLSearchParams({ from, to })}`),
  queryMemory: (projectId, question, budget) => request(`/projects/${projectId}/memory/query?${new URLSearchParams({ q: question, ...(budget ? { budget } : {}) })}`),
  compileMemoryContext: (projectId, input) => request(`/projects/${projectId}/memory/context`, { method: 'POST', body: input }),
  listMemoryContexts: (projectId, limit = 20) => request(`/projects/${projectId}/memory/context?${new URLSearchParams({ limit })}`),
  getMemoryContext: (projectId, capsuleId) => request(`/projects/${projectId}/memory/context/${encodeURIComponent(capsuleId)}`),
  listFeatures: (projectId) => request(`/projects/${projectId}/features`),
  createFeature: (projectId, input) => request(`/projects/${projectId}/features`, { method: 'POST', body: input }),
  updateFeature: (projectId, featureId, input) => request(`/projects/${projectId}/features/${encodeURIComponent(featureId)}`, { method: 'PATCH', body: input }),
  listFeaturePlans: (projectId, featureId) => request(`/projects/${projectId}/features/${encodeURIComponent(featureId)}/plans`),
  planFeature: (projectId, featureId, input = {}) => request(`/projects/${projectId}/features/${encodeURIComponent(featureId)}/plan`, { method: 'POST', body: input }),
  planIssue: (projectId, issueId, input = {}) => request(`/projects/${projectId}/issues/${issueId}/plan`, { method: 'POST', body: input }),
  expandMilestone: (projectId, milestoneId, input = {}) => request(`/projects/${projectId}/timeline/nodes/${encodeURIComponent(milestoneId)}/expansions`, { method: 'POST', body: input }),
  getPlanningRequest: (projectId, requestId) => request(`/projects/${projectId}/planning/${encodeURIComponent(requestId)}`),
  acceptPlanningRequest: (projectId, requestId) => request(`/projects/${projectId}/planning/${encodeURIComponent(requestId)}/accept`, { method: 'POST', body: {} }),
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
  syncGit: (projectId) => request(`/projects/${projectId}/git/sync`, { method: 'POST', body: {} }),
  getBranches: (projectId) => request(`/projects/${projectId}/branches`),
  getRemoteStatus: (projectId) => request(`/projects/${projectId}/remote/status`),
  getRemotePrs: (projectId) => request(`/projects/${projectId}/remote/prs`),
  getRemoteIssues: (projectId) => request(`/projects/${projectId}/remote/issues`),
  syncRemote: (projectId) => request(`/projects/${projectId}/remote/sync`, { method: 'POST', body: {} })
};
