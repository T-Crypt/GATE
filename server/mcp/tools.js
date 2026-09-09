import * as z from 'zod/v4';

function actorContext(idempotencyKey) {
  return {
    actor: { type: 'mcp', id: 'mcp:local' },
    correlationId: `mcp:${idempotencyKey || 'read'}`,
    idempotencyKey
  };
}

function success(value) {
  const structuredContent = Array.isArray(value) ? { items: value } : value;
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}

function handler(action) {
  return async (input) => {
    try {
      return success(await action(input));
    } catch (error) {
      const code = error.code || 'INTERNAL_ERROR';
      return {
        isError: true,
        content: [{ type: 'text', text: `${code}: ${error.message}` }],
        structuredContent: { error: { code, message: error.message } }
      };
    }
  };
}

const projectId = z.number().int().positive();
const idempotencyKey = z.string().trim().min(1).max(200);
const graph = z.object({
  nodes: z.array(z.looseObject({})).max(2000),
  edges: z.array(z.looseObject({})).max(5000),
  gates: z.array(z.looseObject({})).max(5000).default([])
});

export function registerTools(server, services) {
  server.registerTool(
    'project_list',
    {
      description: 'List local Gate projects and their safety policy.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler(() => ({ projects: services.projects.list() }))
  );

  server.registerTool(
    'timeline_get',
    {
      description: 'Read timeline nodes, dependency edges, and gates for a project.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler(({ projectId: id }) => services.timeline.get(id))
  );

  server.registerTool(
    'timeline_replace_draft',
    {
      description: 'Validate and replace editable timeline content while preserving protected work.',
      inputSchema: { projectId, idempotencyKey, graph },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, idempotencyKey: key, graph: value }) =>
      services.timeline.replaceDraft(id, value, actorContext(key))
    )
  );

  server.registerTool(
    'timeline_draft',
    {
      description: 'Ask the configured provider to propose a timeline without applying it.',
      inputSchema: { projectId, goal: z.string().trim().min(3).max(20_000), idempotencyKey },
      annotations: { idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, goal, idempotencyKey: key }) =>
      services.execution.draftTimeline(id, goal, actorContext(key))
    )
  );

  server.registerTool(
    'timeline_accept_draft',
    {
      description: 'Accept one validated proposed timeline draft.',
      inputSchema: { projectId, draftId: z.string().uuid(), idempotencyKey },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, draftId, idempotencyKey: key }) =>
      services.execution.acceptDraft(id, draftId, actorContext(key))
    )
  );

  server.registerTool(
    'step_start',
    {
      description: 'Start one ready timeline step in its isolated run worktree.',
      inputSchema: { projectId, nodeId: z.string().trim().min(1).max(200), idempotencyKey },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, nodeId, idempotencyKey: key }) =>
      services.execution.start(id, nodeId, actorContext(key))
    )
  );

  server.registerTool(
    'step_schedule',
    {
      description: 'Start the next dependency-ready step when automatic mode allows it.',
      inputSchema: { projectId, idempotencyKey },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, idempotencyKey: key }) =>
      services.execution.schedule(id, actorContext(key))
    )
  );

  server.registerTool(
    'step_cancel',
    {
      description: 'Cancel an active provider run without deleting its worktree.',
      inputSchema: { runId: z.string().uuid(), idempotencyKey },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    handler(({ runId, idempotencyKey: key }) =>
      services.execution.cancel(runId, actorContext(key))
    )
  );

  server.registerTool(
    'run_get',
    {
      description: 'Read one run including branch, worktree, provider, and status.',
      inputSchema: { runId: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler(({ runId }) => services.execution.get(runId))
  );

  server.registerTool(
    'review_get',
    {
      description: 'Read gates, evidence, approvals, and recent runs for human review.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler(({ projectId: id }) => services.reviews.get(id))
  );

  server.registerTool(
    'gate_submit_evidence',
    {
      description: 'Attach commit-bound local evidence to a timeline gate.',
      inputSchema: {
        projectId,
        gateId: z.string().trim().min(1).max(200),
        kind: z.string().trim().min(1).max(80),
        headSha: z.string().trim().min(1).max(256),
        fileScope: z.array(z.string().trim().min(1).max(4096)).max(250).default([]),
        command: z.string().trim().max(4096).optional(),
        exitCode: z.number().int().optional(),
        output: z.string().max(100_000).default(''),
        artifactPath: z.string().trim().max(4096).optional(),
        idempotencyKey
      },
      annotations: { idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, gateId, idempotencyKey: key, ...input }) =>
      services.reviews.submitEvidence(id, gateId, input, actorContext(key))
    )
  );

  server.registerTool(
    'issue_create',
    {
      description: 'Create a local issue, bug report, or feature request. Use kind "bug" for a bug report, "feature" for a feature request, or omit for a general task.',
      inputSchema: {
        projectId,
        title: z.string().trim().min(1).max(500),
        branch: z.string().trim().max(250).optional(),
        kind: z.enum(['bug', 'feature', 'task']).optional(),
        idempotencyKey
      },
      annotations: { idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, idempotencyKey: key, ...input }) =>
      services.dashboard.addIssue(id, input, actorContext(key))
    )
  );

  server.registerTool(
    'issue_update',
    {
      description: 'Update the status of a local issue.',
      inputSchema: {
        projectId,
        issueId: z.number().int().positive(),
        status: z.enum(['open', 'in_progress', 'closed']),
        idempotencyKey
      },
      annotations: { idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, issueId, status, idempotencyKey: key }) =>
      services.dashboard.updateIssue(id, issueId, { status }, actorContext(key))
    )
  );

  server.registerTool(
    'note_create',
    {
      description: 'Record a local project note with optional tags.',
      inputSchema: {
        projectId,
        body: z.string().trim().min(1).max(10_000),
        tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
        idempotencyKey
      },
      annotations: { idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, idempotencyKey: key, ...input }) =>
      services.dashboard.addNote(id, input, actorContext(key))
    )
  );

  server.registerTool(
    'activity_feed',
    {
      description: 'Read recent timeline-driven runs and activity for a project, newest first.',
      inputSchema: { projectId, limit: z.number().int().positive().max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, limit }) => services.execution.activityFeed(id, limit))
  );

  server.registerTool(
    'memory_status',
    {
      description: 'Read the local GATE Memory revision, staleness, and structural graph counts.',
      inputSchema: { projectId },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler(({ projectId: id }) => services.memory.status(id))
  );

  server.registerTool(
    'memory_search',
    {
      description: 'Search the local structural graph by file path or symbol name. Results retain repository provenance.',
      inputSchema: {
        projectId,
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().positive().max(100).optional(),
        type: z.enum(['file', 'directory', 'repository', 'symbol']).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, ...input }) => services.memory.search(id, input))
  );

  server.registerTool(
    'memory_neighbors',
    {
      description: 'Traverse deterministic containment, import, and reference edges around a memory node.',
      inputSchema: {
        projectId,
        nodeId: z.string().trim().min(1).max(500),
        depth: z.number().int().positive().max(4).optional(),
        edgeTypes: z.array(z.enum(['CONTAINS', 'IMPORTS', 'REFERENCES'])).max(3).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, nodeId, depth, edgeTypes }) => services.memory.neighbors(id, nodeId, { depth, edgeTypes }))
  );

  server.registerTool(
    'memory_impact',
    {
      description: 'Find matching files or symbols, declaring files, transitive import dependents, and affected tests.',
      inputSchema: { projectId, query: z.string().trim().min(1).max(500), limit: z.number().int().positive().max(25).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, ...input }) => services.memory.impact(id, input))
  );

  server.registerTool(
    'memory_refresh',
    {
      description: 'Refresh GATE Memory from the local Git repository. The mutation is idempotent.',
      inputSchema: { projectId, force: z.boolean().optional(), idempotencyKey },
      annotations: { idempotentHint: true, openWorldHint: false }
    },
    handler(({ projectId: id, idempotencyKey: key, force = false }) =>
      services.memory.refresh(id, { force }, actorContext(key))
    )
  );
}
