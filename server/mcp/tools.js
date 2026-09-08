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
      description: 'List local Project MCP projects and their safety policy.',
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

}
