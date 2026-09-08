import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { AppError, notFound, validation } from '../domain/errors.js';
import { evidenceIsFresh } from '../domain/gates.js';
import { runIdempotent } from './idempotency.js';

function decodeEvidence(row) {
  if (!row) return row;
  return {
    id: row.id, gateId: row.gate_id, projectId: row.project_id, kind: row.kind,
    headSha: row.head_sha, fileScope: JSON.parse(row.file_scope_json), command: row.command,
    exitCode: row.exit_code, output: row.output, artifactPath: row.artifact_path,
    status: row.status, createdAt: row.created_at
  };
}

function decodeApproval(row) {
  if (!row) return row;
  return {
    id: row.id, gateId: row.gate_id, projectId: row.project_id,
    decision: row.decision, actorId: row.actor_id, note: row.note,
    headSha: row.head_sha, createdAt: row.created_at
  };
}

function cleanText(value, field, max = 20_000) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw validation(`${field} is required`, { field });
  if (normalized.length > max) throw validation(`${field} is too long`, { field, max });
  return normalized;
}

function safeArtifactPath(value) {
  if (value === undefined || value === null || value === '') return null;
  const candidate = cleanText(value, 'artifactPath', 4096);
  if (path.isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..')) {
    throw validation('artifactPath must be relative to the local evidence directory', { field: 'artifactPath' });
  }
  return candidate;
}

export class ReviewService {
  constructor(db, eventStore) {
    this.db = db;
    this.events = eventStore;
  }

  #gate(projectId, gateId) {
    const gate = this.db.prepare('SELECT * FROM gates WHERE project_id = ? AND id = ?').get(projectId, gateId);
    if (!gate) throw notFound('Gate', gateId);
    return gate;
  }

  #headForGate(gate) {
    return this.db.prepare(
      `SELECT head_sha FROM runs WHERE project_id = ? AND node_id = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`
    ).get(gate.project_id, gate.node_id)?.head_sha || null;
  }

  submitEvidence(projectId, gateId, input, context) {
    return runIdempotent(this.db, context, { command: 'gate.submitEvidence', projectId, gateId, input }, () => {
      this.#gate(projectId, gateId);
      const evidence = {
        id: randomUUID(), gateId, projectId,
        kind: cleanText(input.kind, 'kind', 80),
        headSha: cleanText(input.headSha, 'headSha', 256),
        fileScope: Array.isArray(input.fileScope) ? input.fileScope.map((item) => cleanText(item, 'fileScope', 4096)) : [],
        command: input.command ? cleanText(input.command, 'command', 4096) : null,
        exitCode: input.exitCode === undefined || input.exitCode === null ? null : Number(input.exitCode),
        output: String(input.output || '').slice(0, 100_000),
        artifactPath: safeArtifactPath(input.artifactPath)
      };
      if (evidence.exitCode !== null && !Number.isInteger(evidence.exitCode)) {
        throw validation('exitCode must be an integer', { field: 'exitCode' });
      }
      this.events.append({
        projectId, type: 'gate.evidence.submitted', actor: context.actor,
        correlationId: context.correlationId, payload: evidence
      }, () => {
        this.db.prepare(
          `INSERT INTO evidence(id, gate_id, project_id, kind, head_sha, file_scope_json,
             command, exit_code, output, artifact_path, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fresh')`
        ).run(
          evidence.id, gateId, projectId, evidence.kind, evidence.headSha,
          JSON.stringify(evidence.fileScope), evidence.command, evidence.exitCode,
          evidence.output, evidence.artifactPath
        );
      });
      return decodeEvidence(this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(evidence.id));
    });
  }

  decide(projectId, gateId, input, context) {
    if (context?.actor?.type !== 'human') {
      throw new AppError('HUMAN_REVIEW_REQUIRED', 'Only a human actor can decide an approval gate', {
        status: 403
      });
    }
    return runIdempotent(this.db, context, { command: 'gate.decide', projectId, gateId, input }, () => {
      const gate = this.#gate(projectId, gateId);
      const decision = cleanText(input.decision, 'decision', 20);
      if (!['approved', 'rejected'].includes(decision)) {
        throw validation('decision must be approved or rejected', { field: 'decision' });
      }
      const evidence = decodeEvidence(this.db.prepare(
        'SELECT * FROM evidence WHERE project_id = ? AND gate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      ).get(projectId, gateId));
      const headSha = this.#headForGate(gate);
      if (decision === 'approved' && (!headSha || !evidenceIsFresh(evidence, headSha))) {
        throw new AppError('STALE_EVIDENCE', 'Evidence is stale for the current run HEAD', {
          status: 409,
          details: { evidenceHead: evidence?.headSha || null, currentHead: headSha }
        });
      }
      const approval = {
        id: randomUUID(), gateId, projectId, decision, actorId: context.actor.id,
        note: String(input.note || '').trim().slice(0, 10_000),
        headSha: headSha || evidence?.headSha || 'unavailable'
      };
      this.events.append({
        projectId, type: 'gate.approval.decided', actor: context.actor,
        correlationId: context.correlationId, payload: approval
      }, () => {
        this.db.prepare(
          `INSERT INTO approvals(id, gate_id, project_id, decision, actor_id, note, head_sha)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(approval.id, gateId, projectId, decision, approval.actorId, approval.note, approval.headSha);
        this.db.prepare("UPDATE gates SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run(decision === 'approved' ? 'passed' : 'failed', gateId);
      });
      return decodeApproval(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approval.id));
    });
  }

  get(projectId) {
    const evidence = this.db.prepare('SELECT * FROM evidence WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId).map(decodeEvidence);
    const approvals = this.db.prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId).map(decodeApproval);
    const gates = this.db.prepare('SELECT * FROM gates WHERE project_id = ? ORDER BY created_at, rowid').all(projectId).map((row) => {
      const latest = evidence.find((item) => item.gateId === row.id);
      const currentHead = this.#headForGate(row);
      const fresh = Boolean(currentHead && evidenceIsFresh(latest, currentHead));
      return {
        id: row.id, projectId: row.project_id, nodeId: row.node_id, type: row.type,
        title: row.title, status: row.status, blocking: Boolean(row.blocking),
        requiredEvidence: JSON.parse(row.required_evidence_json),
        evidenceState: latest ? (fresh ? 'fresh' : 'stale') : 'missing',
        currentHead, canApprove: row.status !== 'passed' && fresh,
        latestEvidence: latest || null
      };
    });
    return {
      gates, evidence, approvals,
      runs: this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 25').all(projectId)
    };
  }
}
