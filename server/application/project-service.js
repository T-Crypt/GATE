import fs from 'node:fs';
import path from 'node:path';

import { runIdempotent } from './idempotency.js';
import { AppError, notFound, validation } from '../domain/errors.js';

function text(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw validation(`${field} is required`, { field });
  return normalized;
}

function optionalBranch(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const branch = text(value, field);
  if (/\s|\.\.|[~^:?*\[\\]/.test(branch) || branch.startsWith('-') || branch.endsWith('.')) {
    throw validation(`${field} is not a valid branch name`, { field });
  }
  return branch;
}

function normalizePolicy(input, current = {}) {
  const baseBranch = optionalBranch(input.baseBranch ?? current.baseBranch ?? 'main', 'baseBranch');
  const productionBranch = optionalBranch(
    input.productionBranch ?? current.productionBranch,
    'productionBranch'
  );
  const stableBranch = optionalBranch(input.stableBranch ?? current.stableBranch, 'stableBranch');
  const requested = input.protectedBranches ?? current.protectedBranches ?? [];
  if (!Array.isArray(requested)) {
    throw validation('protectedBranches must be an array', { field: 'protectedBranches' });
  }
  const protectedBranches = [
    ...new Set(
      [
        baseBranch,
        productionBranch,
        stableBranch,
        ...requested.map((branch) => optionalBranch(branch, 'protectedBranches'))
      ].filter(Boolean)
    )
  ].sort((left, right) => left.localeCompare(right));

  return { baseBranch, productionBranch, stableBranch, protectedBranches };
}

function decodeProject(row) {
  if (!row) return row;
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    baseBranch: row.base_branch,
    productionBranch: row.production_branch,
    stableBranch: row.stable_branch,
    protectedBranches: JSON.parse(row.protected_branches_json),
    interactionLevel: row.interaction_level,
    providerKind: row.provider_kind,
    providerConfig: JSON.parse(row.provider_config_json),
    lastSequence: row.last_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function canonicalRepository(repoPath) {
  let canonical;
  try {
    canonical = fs.realpathSync(text(repoPath, 'repoPath'));
  } catch {
    throw new AppError('INVALID_REPOSITORY', 'Repository path does not exist', { status: 422 });
  }
  if (!fs.existsSync(path.join(canonical, '.git'))) {
    throw new AppError('INVALID_REPOSITORY', 'Path is not a Git repository or worktree', {
      status: 422
    });
  }
  return canonical;
}

export class ProjectService {
  constructor(db, eventStore) {
    this.db = db;
    this.events = eventStore;
  }

  create(input, context) {
    return runIdempotent(this.db, context, { command: 'project.create', input }, () => {
      const name = text(input.name, 'name');
      const repoPath = canonicalRepository(input.repoPath);
      const policy = normalizePolicy(input);
      const result = this.db
        .prepare(
          `INSERT INTO projects(
             name, repo_path, base_branch, production_branch, stable_branch,
             protected_branches_json, interaction_level, provider_kind, provider_config_json,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(
          name,
          repoPath,
          policy.baseBranch,
          policy.productionBranch,
          policy.stableBranch,
          JSON.stringify(policy.protectedBranches),
          input.interactionLevel || 'assist',
          input.providerKind || 'claude',
          JSON.stringify(input.providerConfig || {})
        );
      const projectId = Number(result.lastInsertRowid);
      this.events.append({
        projectId,
        type: 'project.created',
        actor: context.actor,
        correlationId: context.correlationId,
        payload: { name, repoPath, ...policy }
      });
      return this.get(projectId);
    });
  }

  updatePolicy(projectId, input, context) {
    return runIdempotent(
      this.db,
      context,
      { command: 'project.updatePolicy', projectId, input },
      () => {
        const current = this.get(projectId);
        const policy = normalizePolicy(input, current);
        const interactionLevel = input.interactionLevel ?? current.interactionLevel;
        if (!['observe', 'assist', 'automatic', 'custom'].includes(interactionLevel)) {
          throw validation('Unknown interaction level', { field: 'interactionLevel' });
        }

        this.events.append(
          {
            projectId,
            type: 'project.policy.updated',
            actor: context.actor,
            correlationId: context.correlationId,
            payload: { ...policy, interactionLevel }
          },
          () => {
            this.db
              .prepare(
                `UPDATE projects SET
                   base_branch = ?, production_branch = ?, stable_branch = ?,
                   protected_branches_json = ?, interaction_level = ?, updated_at = datetime('now')
                 WHERE id = ?`
              )
              .run(
                policy.baseBranch,
                policy.productionBranch,
                policy.stableBranch,
                JSON.stringify(policy.protectedBranches),
                interactionLevel,
                projectId
              );
          }
        );
        return this.get(projectId);
      }
    );
  }

  get(projectId) {
    const project = decodeProject(
      this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
    );
    if (!project) throw notFound('Project', projectId);
    return project;
  }

  list() {
    return this.db.prepare('SELECT * FROM projects ORDER BY id DESC').all().map(decodeProject);
  }
}
