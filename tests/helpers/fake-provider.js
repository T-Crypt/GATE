export class FakeProvider {
  constructor({ draft, exitCode = 0, delayMs = 0 } = {}) {
    this.requests = [];
    this.draftRequests = [];
    this.draft = draft;
    this.exitCode = exitCode;
    this.delayMs = delayMs;
    this.cancelled = new Set();
  }

  capabilities() {
    return { streaming: true, structuredDrafts: true };
  }

  async start(request, observer) {
    this.requests.push(request);
    observer?.onOutput?.(`working:${request.nodeKey}\n`);
    return {
      sessionId: `fake-${this.requests.length}`,
      completion: new Promise((resolve) => {
        setTimeout(() => resolve({ exitCode: this.exitCode, signal: null }), this.delayMs);
      }),
      cancel: async () => {
        this.cancelled.add(request.runId);
      }
    };
  }

  async draftTimeline(request) {
    this.draftRequests.push(request);
    const { goal } = request;
    return this.draft || {
      nodes: [
        { id: 'draft-m', key: 'A', kind: 'milestone', title: goal, ordinal: 0 },
        {
          id: 'draft-s',
          key: 'A-1',
          kind: 'step',
          parentId: 'draft-m',
          title: 'First step',
          ordinal: 0
        }
      ],
      edges: [],
      gates: []
    };
  }
}
