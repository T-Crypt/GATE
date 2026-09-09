import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { runIdempotent } from './idempotency.js';
import { validation } from '../domain/errors.js';

const FILE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md']);
const USER_START = '<!-- GATE:USER:START -->';
const USER_END = '<!-- GATE:USER:END -->';
const MANAGED_START = '<!-- GATE:MANAGED:START -->';
const MANAGED_END = '<!-- GATE:MANAGED:END -->';

const MANAGED_CONTRACT = `This repository is managed by GATE.

Before planning project-wide changes:
- query GATE Memory and inspect the current timeline state
- respect accepted architecture decisions and project policy

Before implementation:
- operate only in the assigned isolated worktree
- follow the approved milestone and submit required evidence
- never approve a gate, merge, push, or mutate a protected branch`;

function documentPath(project, fileName) {
  if (!FILE_NAMES.has(fileName)) {
    throw validation('fileName must be AGENTS.md or CLAUDE.md', { field: 'fileName' });
  }
  return path.join(project.repoPath, fileName);
}

function markerCount(content, marker) {
  return content.split(marker).length - 1;
}

function section(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) return null;
  return {
    start,
    end: end + endMarker.length,
    body: content.slice(start + startMarker.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  };
}

function parse(content) {
  const hasMarkers = [USER_START, USER_END, MANAGED_START, MANAGED_END]
    .some((marker) => content.includes(marker));
  if (!hasMarkers) return { status: 'untracked', userContent: content };

  const user = section(content, USER_START, USER_END);
  const managed = section(content, MANAGED_START, MANAGED_END);
  const valid = user && managed &&
    markerCount(content, USER_START) === 1 && markerCount(content, USER_END) === 1 &&
    markerCount(content, MANAGED_START) === 1 && markerCount(content, MANAGED_END) === 1 &&
    user.end < managed.start;
  if (!valid) return { status: 'corrupt', userContent: content };
  return { status: 'valid', userContent: user.body, managedContent: managed.body };
}

function render(userContent) {
  const normalized = String(userContent ?? '').replace(/\r\n/g, '\n').trim();
  return `${USER_START}\n${normalized}${normalized ? '\n' : ''}${USER_END}\n\n${MANAGED_START}\n${MANAGED_CONTRACT}\n${MANAGED_END}\n`;
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

export class InstructionService {
  constructor({ db, projects, eventStore }) {
    this.db = db;
    this.projects = projects;
    this.events = eventStore;
  }

  get(projectId, fileName) {
    const project = this.projects.get(projectId);
    const target = documentPath(project, fileName);
    if (!fs.existsSync(target)) {
      return {
        projectId,
        fileName,
        exists: false,
        status: 'missing',
        userContent: '',
        managedContent: MANAGED_CONTRACT,
        content: ''
      };
    }
    const content = fs.readFileSync(target, 'utf8');
    const parsed = parse(content);
    return {
      projectId,
      fileName,
      exists: true,
      status: parsed.status,
      userContent: parsed.userContent,
      managedContent: parsed.managedContent || MANAGED_CONTRACT,
      content
    };
  }

  list(projectId) {
    return [...FILE_NAMES].map((fileName) => this.get(projectId, fileName));
  }

  update(projectId, input, context) {
    return runIdempotent(
      this.db,
      context,
      { command: 'project.instructions.update', projectId, input },
      () => {
        const userContent = String(input.userContent ?? '');
        if (userContent.length > 100_000) {
          throw validation('userContent is too large', { field: 'userContent' });
        }
        const current = this.get(projectId, input.fileName);
        const project = this.projects.get(projectId);
        fs.writeFileSync(documentPath(project, input.fileName), render(userContent), 'utf8');
        const managedContractHash = digest(MANAGED_CONTRACT);

        this.events.append(
          {
            projectId,
            type: 'project.instructions.updated',
            actor: context.actor,
            correlationId: context.correlationId,
            payload: { fileName: input.fileName, previousStatus: current.status, managedContractHash }
          },
          () => {
            this.db.prepare(
              `INSERT INTO project_instruction_documents(project_id, file_name, managed_contract_hash, status, updated_at)
               VALUES (?, ?, ?, 'valid', datetime('now'))
               ON CONFLICT(project_id, file_name) DO UPDATE SET
                 managed_contract_hash = excluded.managed_contract_hash,
                 status = excluded.status,
                 updated_at = excluded.updated_at`
            ).run(projectId, input.fileName, managedContractHash);
          }
        );
        return this.get(projectId, input.fileName);
      }
    );
  }
}
