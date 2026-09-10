import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { runIdempotent } from './idempotency.js';
import { estimateTokens, trimToBudget } from './token-budget.js';
import { AppError, notFound, validation } from '../domain/errors.js';

const KINDS = new Set(['context', 'planning', 'execution']);

function decode(row) {
  if (!row) return row;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    goal: row.goal,
    repositorySha: row.repository_sha,
    memoryRevisionSha: row.memory_revision_sha,
    tokenBudget: row.token_budget,
    estimatedTokens: row.estimated_tokens,
    payload: JSON.parse(row.payload_json),
    provenance: JSON.parse(row.provenance_json),
    contentHash: row.content_hash,
    createdAt: row.created_at
  };
}

function uniqueNodes(nodes) {
  return [...new Map(nodes.filter(Boolean).map((node) => [node.id, node])).values()];
}

function readExcerpt(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(target)) return '';
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > 1_000_000) return '';
  const content = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  return content.slice(0, 2400);
}

function textFields(payload) {
  return [
    ...payload.files.map((item) => ({ item, key: 'excerpt' })),
    ...payload.tests.map((item) => ({ item, key: 'excerpt' })),
    ...payload.projectRules.flatMap((item) => [
      { item, key: 'userContent' },
      { item, key: 'managedContent' }
    ])
  ].filter(({ item, key }) => item[key]?.length > 160);
}

function trimPayload(payload, tokenBudget) {
  return trimToBudget(
    payload,
    tokenBudget,
    [
      (value) => {
        const fields = textFields(value).sort((left, right) => right.item[right.key].length - left.item[left.key].length);
        if (!fields.length) return false;
        const { item, key } = fields[0];
        item[key] = `${item[key].slice(0, Math.max(160, Math.floor(item[key].length * 0.65))).trimEnd()}…`;
        return true;
      },
      (value) => {
        if (value.files.length <= 1) return false;
        value.files.pop();
        return true;
      },
      (value) => {
        if (!value.tests.length) return false;
        value.tests.pop();
        return true;
      },
      (value) => {
        if (value.symbols.length <= 1) return false;
        value.symbols.pop();
        return true;
      }
    ],
    () => {
      throw validation('tokenBudget is too small for the required project context', { field: 'tokenBudget' });
    }
  );
}

function contentHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export class ContextCompiler {
  constructor({ db, projects, memory, instructions, gitAdapter, eventStore }) {
    this.db = db;
    this.projects = projects;
    this.memory = memory;
    this.instructions = instructions;
    this.git = gitAdapter;
    this.events = eventStore;
  }

  async compile(projectId, input, context) {
    const project = this.projects.get(projectId);
    const goal = String(input.goal || '').trim();
    if (goal.length < 3 || goal.length > 20_000) throw validation('goal must be between 3 and 20000 characters', { field: 'goal' });
    const kind = String(input.kind || 'context').toLowerCase();
    if (!KINDS.has(kind)) throw validation('kind must be context, planning, or execution', { field: 'kind' });
    const tokenBudget = Math.trunc(Number(input.tokenBudget) || 4000);
    if (tokenBudget < 512 || tokenBudget > 32_000) throw validation('tokenBudget must be between 512 and 32000', { field: 'tokenBudget' });

    const memoryStatus = await this.memory.status(projectId);
    if (memoryStatus.state !== 'ready' || memoryStatus.stale) {
      throw new AppError('MEMORY_STALE', 'GATE Memory must be current before compiling context', {
        status: 409,
        details: { repositorySha: memoryStatus.repositorySha, indexedSha: memoryStatus.indexedSha }
      });
    }

    const search = this.memory.search(projectId, { query: goal, limit: 30 });
    const impact = this.memory.impact(projectId, { query: goal, limit: 25 });
    const searchFiles = search.items.filter((node) => node.type === 'file');
    const searchSymbols = search.items.filter((node) => node.type === 'symbol');
    const files = uniqueNodes([...impact.declaringFiles, ...impact.dependents, ...searchFiles])
      .filter((node) => !node.metadata.isTest);
    const tests = uniqueNodes([...impact.tests, ...searchFiles.filter((node) => node.metadata.isTest)]);
    const symbols = uniqueNodes([...impact.symbols, ...searchSymbols]);
    const projectRules = this.instructions.list(projectId).filter((document) => document.exists).map((document) => ({
      fileName: document.fileName,
      status: document.status,
      userContent: document.status === 'corrupt' ? '' : document.userContent.slice(0, 4000),
      managedContent: document.managedContent.slice(0, 4000)
    }));
    const reasonFor = (node) => search.items.find((item) => item.id === node.id)?.matchReasons || impact.reasons[node.id] || [];
    const payload = trimPayload({
      goal,
      project: { id: project.id, name: project.name, stage: project.stage, revision: memoryStatus.indexedSha },
      projectRules,
      files: files.map((node) => ({ nodeId: node.id, path: node.path, reasons: reasonFor(node), excerpt: readExcerpt(project.repoPath, node.path) })),
      symbols: symbols.map((node) => ({
        nodeId: node.id,
        path: node.sourcePath,
        name: node.name,
        kind: node.metadata.kind,
        line: node.metadata.line,
        exported: node.metadata.exported,
        reasons: reasonFor(node)
      })),
      tests: tests.map((node) => ({ nodeId: node.id, path: node.path, reasons: reasonFor(node), excerpt: readExcerpt(project.repoPath, node.path) })),
      structuralEdges: impact.edges.map((edge) => ({
        id: edge.id,
        type: edge.type,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        origin: edge.provenance.origin
      }))
    }, tokenBudget);
    const finalStatus = await this.memory.status(projectId);
    if (finalStatus.stale || finalStatus.indexedSha !== memoryStatus.indexedSha) {
      throw new AppError('MEMORY_STALE', 'Repository changed while context was being compiled', { status: 409 });
    }

    const selectedNodes = uniqueNodes([...files, ...tests, ...symbols]);
    const provenance = {
      repositorySha: finalStatus.repositorySha,
      memoryRevisionSha: finalStatus.indexedSha,
      graphNodeIds: selectedNodes.map((node) => node.id),
      sourceFiles: [...new Set([...files, ...tests].map((node) => node.path))],
      instructionFiles: projectRules.map((document) => document.fileName),
      retrieval: search.items.map((node) => ({ nodeId: node.id, strategy: node.matchStrategy, score: node.score }))
    };

    return runIdempotent(
      this.db,
      context,
      { command: 'context.compile', projectId, input: { goal, kind, tokenBudget } },
      () => {
        const id = randomUUID();
        const estimatedTokens = estimateTokens(payload);
        const hash = contentHash(payload);
        this.events.append(
          {
            projectId,
            type: 'context.compiled',
            actor: context.actor,
            correlationId: context.correlationId,
            payload: {
              capsuleId: id,
              kind,
              repositorySha: finalStatus.repositorySha,
              memoryRevisionSha: finalStatus.indexedSha,
              tokenBudget,
              estimatedTokens,
              graphNodeCount: provenance.graphNodeIds.length,
              sourceFileCount: provenance.sourceFiles.length,
              contentHash: hash
            }
          },
          () => {
            this.db.prepare(
              `INSERT INTO context_capsules(
                 id, project_id, kind, goal, repository_sha, memory_revision_sha,
                 token_budget, estimated_tokens, payload_json, provenance_json, content_hash
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              id, projectId, kind, goal, finalStatus.repositorySha, finalStatus.indexedSha,
              tokenBudget, estimatedTokens, JSON.stringify(payload), JSON.stringify(provenance), hash
            );
          }
        );
        return this.get(projectId, id);
      }
    );
  }

  get(projectId, capsuleId) {
    this.projects.get(projectId);
    const capsule = decode(this.db.prepare('SELECT * FROM context_capsules WHERE project_id = ? AND id = ?').get(projectId, capsuleId));
    if (!capsule) throw notFound('Context capsule', capsuleId);
    return capsule;
  }

  list(projectId, requestedLimit = 20) {
    this.projects.get(projectId);
    const safeLimit = Math.max(1, Math.min(Number(requestedLimit) || 20, 100));
    return this.db.prepare(
      'SELECT * FROM context_capsules WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
    ).all(projectId, safeLimit).map(decode);
  }
}
