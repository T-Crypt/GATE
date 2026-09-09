import { randomUUID } from 'node:crypto';

import { runIdempotent } from './idempotency.js';
import { normalizeTimelineGraph } from './timeline-service.js';
import { deriveReadiness } from '../domain/timeline.js';
import { AppError, notFound } from '../domain/errors.js';

function decodeRun(row) {
  if (!row) return row;
  return {
    id: row.id,
    projectId: row.project_id,
    nodeId: row.node_id,
    providerKind: row.provider_kind,
    providerSessionId: row.provider_session_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    status: row.status,
    output: row.output,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function internalContext(context, suffix, actor = context.actor) {
  return {
    actor,
    correlationId: context.correlationId,
    idempotencyKey: `${context.idempotencyKey}:${suffix}`
  };
}

function buildRepositoryContext(project, digest) {
  const base = `Repository ${project.repoPath}; base ${project.baseBranch}`;
  if (!digest) return base;
  const files = JSON.parse(digest.file_tree_json);
  const milestones = JSON.parse(digest.milestones_json);
  const parts = [base];
  if (files.length) parts.push(`Files:\n${files.join('\n')}`);
  if (milestones.length) {
    parts.push(`Existing milestones:\n${milestones.map((m) => `${m.display_key || ''} ${m.title}`.trim()).join('\n')}`);
  }
  return parts.join('\n\n');
}

export class ExecutionService {
  constructor({
    db,
    eventStore,
    projectService,
    timelineService,
    gitAdapter,
    providers,
    worktreeDir,
    outputLimitBytes = 2_000_000
  }) {
    this.db = db;
    this.events = eventStore;
    this.projects = projectService;
    this.timeline = timelineService;
    this.git = gitAdapter;
    this.providers = providers;
    this.worktreeDir = worktreeDir;
    this.outputLimitBytes = outputLimitBytes;
    this.liveRuns = new Map();
  }

  async schedule(projectId, context) {
    const project = this.projects.get(projectId);
    if (project.interactionLevel !== 'automatic') return [];
    const active = this.db
      .prepare("SELECT id FROM runs WHERE project_id = ? AND status IN ('starting', 'running') LIMIT 1")
      .get(projectId);
    if (active) return [];

    const timeline = this.timeline.get(projectId);
    const candidates = timeline.nodes
      .filter((node) => node.kind === 'step' && ['planned', 'blocked', 'ready'].includes(node.status))
      .sort((left, right) => left.ordinal - right.ordinal);
    for (const node of candidates) {
      const dependencies = timeline.edges
        .filter((edge) => edge.toNodeId === node.id)
        .map((edge) => timeline.nodes.find((candidate) => candidate.id === edge.fromNodeId))
        .filter(Boolean);
      const gates = timeline.gates.filter((gate) => gate.nodeId === node.id);
      const readiness = deriveReadiness(node, dependencies, gates);
      if (readiness !== 'ready' && node.status !== 'ready') continue;
      return [await this.start(projectId, node.id, internalContext(context, `start:${node.id}`))];
    }
    return [];
  }

  async start(projectId, nodeId, context) {
    const project = this.projects.get(projectId);
    const timeline = this.timeline.get(projectId);
    const node = timeline.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw notFound('Timeline node', nodeId);
    if (node.kind !== 'step') throw new AppError('STEP_REQUIRED', 'Only timeline steps can run');

    const dependencies = timeline.edges
      .filter((edge) => edge.toNodeId === node.id)
      .map((edge) => timeline.nodes.find((candidate) => candidate.id === edge.fromNodeId))
      .filter(Boolean);
    const gates = timeline.gates.filter((gate) => gate.nodeId === node.id);
    const readiness = deriveReadiness(node, dependencies, gates);
    if (!['ready', 'running'].includes(readiness) && node.status !== 'ready') {
      throw new AppError('STEP_BLOCKED', `Step ${node.key} has unmet dependencies or gates`, {
        status: 409,
        details: {
          dependencies: dependencies.map((dependency) => ({
            id: dependency.id,
            key: dependency.key,
            status: dependency.status
          })),
          gates: gates.map((gate) => ({ id: gate.id, type: gate.type, status: gate.status }))
        }
      });
    }

    const active = this.db
      .prepare("SELECT id FROM runs WHERE project_id = ? AND status IN ('starting', 'running') LIMIT 1")
      .get(projectId);
    if (active) {
      throw new AppError('RUN_ALREADY_ACTIVE', 'This project already has an active mutating run', {
        status: 409,
        details: { runId: active.id }
      });
    }

    if (node.status === 'planned' || node.status === 'blocked') {
      this.timeline.transition(
        projectId,
        nodeId,
        'ready',
        internalContext(context, `ready:${nodeId}`, { type: 'system', id: 'scheduler' })
      );
    } else if (node.status !== 'ready') {
      throw new AppError('STEP_NOT_READY', `Step ${node.key} is ${node.status}`, { status: 409 });
    }

    const provider = this.providers.get(project.providerKind);
    if (!provider) {
      throw new AppError('PROVIDER_UNAVAILABLE', `Provider ${project.providerKind} is not configured`, {
        status: 503
      });
    }

    const runId = randomUUID();
    const worktree = await this.git.createRunWorktree({
      repoPath: project.repoPath,
      baseBranch: project.baseBranch,
      protectedBranches: project.protectedBranches,
      runId,
      parentDir: this.worktreeDir,
      branchPrefix: project.branchPrefix
    });
    this.events.append(
      {
        projectId,
        type: 'agent.run.started',
        actor: context.actor,
        correlationId: context.correlationId,
        payload: { runId, nodeId, branch: worktree.branch, baseSha: worktree.baseSha }
      },
      () => {
        this.db
          .prepare(
            `INSERT INTO runs(
               id, project_id, node_id, provider_kind, branch, worktree_path,
               base_sha, head_sha, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting')`
          )
          .run(
            runId,
            projectId,
            nodeId,
            project.providerKind,
            worktree.branch,
            worktree.path,
            worktree.baseSha,
            worktree.headSha
          );
      }
    );
    this.timeline.transition(
      projectId,
      nodeId,
      'running',
      internalContext(context, `running:${nodeId}`, { type: 'system', id: 'scheduler' })
    );

    const prompt = [
      `You are executing timeline step ${node.key}: ${node.title}.`,
      node.description || 'Complete the step using the repository guidance.',
      'Work only in the assigned worktree. Do not merge, rebase, push, or modify protected branches.',
      'Run relevant tests and report evidence before finishing.'
    ].join('\n\n');
    const session = await provider.start(
      {
        runId,
        nodeId,
        nodeKey: node.key,
        cwd: worktree.path,
        prompt,
        model: project.providerConfig.model,
        outputLimitBytes: this.outputLimitBytes,
        permissionMode: project.providerConfig.permissionMode || 'acceptEdits'
      },
      {
        onOutput: (chunk, stream) => this.#recordOutput(runId, projectId, chunk, stream),
        onOutputLimit: () => this.#recordOutput(runId, projectId, '\n[output limit reached]\n', 'system')
      }
    );
    this.db
      .prepare("UPDATE runs SET provider_session_id = ?, status = 'running' WHERE id = ?")
      .run(session.sessionId, runId);
    this.liveRuns.set(runId, { session, projectId, nodeId, worktree, providerKind: project.providerKind });
    session.completion
      .then((result) => this.#finish(runId, result))
      .catch((error) => this.#finish(runId, { exitCode: 1, error }));
    return this.get(runId);
  }

  async draftTimeline(projectId, goal, context, modelOverride) {
    const project = this.projects.get(projectId);
    const provider = this.providers.get(project.providerKind);
    if (!provider?.draftTimeline) {
      throw new AppError('DRAFTING_UNSUPPORTED', 'The configured provider cannot draft timelines', {
        status: 422
      });
    }
    const digest = this.db.prepare('SELECT * FROM project_digests WHERE project_id = ?').get(projectId) || null;
    const graph = normalizeTimelineGraph(
      await provider.draftTimeline({
        goal: String(goal ?? '').trim(),
        repositoryContext: buildRepositoryContext(project, digest),
        cwd: project.repoPath,
        model: modelOverride || project.providerConfig.model
      })
    );
    return runIdempotent(
      this.db,
      context,
      { command: 'timeline.draft', projectId, goal, graph },
      () => {
        const id = randomUUID();
        this.events.append(
          {
            projectId,
            type: 'timeline.draft.proposed',
            actor: context.actor,
            correlationId: context.correlationId,
            payload: { draftId: id, goal }
          },
          () => {
            this.db
              .prepare(
                `INSERT INTO timeline_drafts(id, project_id, goal, graph_json, provider_kind)
                 VALUES (?, ?, ?, ?, ?)`
              )
              .run(id, projectId, goal, JSON.stringify(graph), project.providerKind);
          }
        );
        return this.#getDraft(id);
      }
    );
  }

  acceptDraft(projectId, draftId, context) {
    const draft = this.#getDraft(draftId);
    if (draft.projectId !== projectId) throw notFound('Timeline draft', draftId);
    if (draft.status !== 'proposed') {
      throw new AppError('DRAFT_NOT_PROPOSED', 'Only proposed drafts can be accepted', { status: 409 });
    }
    const timeline = this.timeline.replaceDraft(
      projectId,
      draft.graph,
      internalContext(context, `apply-draft:${draftId}`)
    );
    this.db
      .prepare("UPDATE timeline_drafts SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?")
      .run(draftId);
    return { ...this.#getDraft(draftId), timeline };
  }

  async cancel(runId, context) {
    const live = this.liveRuns.get(runId);
    if (!live) throw new AppError('RUN_NOT_ACTIVE', 'Run is not active', { status: 409 });
    await live.session.cancel();
    await this.#finish(runId, { exitCode: null, signal: 'SIGTERM', cancelled: true }, context);
    return this.get(runId);
  }

  recoverInterrupted() {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE status IN ('starting', 'running')")
      .all();
    const recovered = [];
    for (const row of rows) {
      this.events.append({
        projectId: row.project_id,
        type: 'agent.run.interrupted',
        actor: { type: 'system', id: 'startup-recovery' },
        correlationId: `recovery:${row.id}`,
        payload: { runId: row.id, nodeId: row.node_id, previousStatus: row.status }
      }, () => {
        this.db.prepare("UPDATE runs SET status = 'interrupted', finished_at = datetime('now') WHERE id = ?").run(row.id);
        this.db.prepare("UPDATE timeline_nodes SET status = 'blocked', updated_at = datetime('now') WHERE id = ? AND status = 'running'").run(row.node_id);
      });
      recovered.push(this.get(row.id));
    }
    return recovered;
  }

  get(runId) {
    const run = decodeRun(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId));
    if (!run) throw notFound('Run', runId);
    return run;
  }

  list(projectId, limit = 50) {
    return this.db
      .prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(projectId, Math.max(1, Math.min(limit, 100)))
      .map(decodeRun);
  }

  activityFeed(projectId, limit = 50) {
    const capped = Math.max(1, Math.min(limit, 200));
    const runs = this.db
      .prepare(
        `SELECT runs.*, timeline_nodes.title AS node_title, timeline_nodes.display_key AS node_key
         FROM runs
         LEFT JOIN timeline_nodes ON timeline_nodes.id = runs.node_id
         WHERE runs.project_id = ?
         ORDER BY runs.started_at DESC LIMIT ?`
      )
      .all(projectId, capped)
      .map((row) => ({ ...decodeRun(row), nodeTitle: row.node_title, nodeKey: row.node_key }));
    const activity = this.db
      .prepare('SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, capped);
    return { runs, activity };
  }

  #recordOutput(runId, projectId, chunk, stream) {
    const sanitized = String(chunk).replace(
      /(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/gi,
      '$1=[REDACTED]'
    );
    this.db
      .prepare('UPDATE runs SET output = substr(output || ?, 1, ?) WHERE id = ?')
      .run(sanitized, this.outputLimitBytes, runId);
    this.db
      .prepare(
        `INSERT INTO activity(project_id, run_id, kind, message, detail_json)
         VALUES (?, ?, 'agent.output', ?, ?)`
      )
      .run(projectId, runId, sanitized, JSON.stringify({ stream }));
    this.events.publishLive(projectId, {
      kind: 'agent.output',
      runId,
      chunk: sanitized,
      stream,
      timestamp: new Date().toISOString()
    });
  }

  async #finish(runId, result) {
    const live = this.liveRuns.get(runId);
    if (!live) return;
    this.liveRuns.delete(runId);
    const cancelled = result.cancelled || result.signal === 'SIGTERM';
    const status = cancelled ? 'cancelled' : result.exitCode === 0 ? 'review' : 'failed';
    let headSha = live.worktree.headSha;
    try {
      headSha = (await this.git.inspect(live.worktree.path)).headSha;
    } catch {
      // Preserve the last verified SHA; the failure remains visible in run output.
    }
    this.db
      .prepare(
        "UPDATE runs SET status = ?, head_sha = ?, finished_at = datetime('now') WHERE id = ?"
      )
      .run(status, headSha, runId);
    const node = this.db.prepare('SELECT status FROM timeline_nodes WHERE id = ?').get(live.nodeId);
    if (node?.status === 'running') {
      const to = status === 'review' ? 'review' : status;
      this.db
        .prepare("UPDATE timeline_nodes SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(to, live.nodeId);
    }
    this.events.append({
      projectId: live.projectId,
      type: `agent.run.${status}`,
      actor: { type: 'provider', id: live.providerKind || 'claude' },
      correlationId: runId,
      payload: { runId, nodeId: live.nodeId, status, headSha }
    });
  }

  #getDraft(draftId) {
    const row = this.db.prepare('SELECT * FROM timeline_drafts WHERE id = ?').get(draftId);
    if (!row) throw notFound('Timeline draft', draftId);
    return {
      id: row.id,
      projectId: row.project_id,
      goal: row.goal,
      status: row.status,
      graph: JSON.parse(row.graph_json),
      providerKind: row.provider_kind,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at
    };
  }
}
