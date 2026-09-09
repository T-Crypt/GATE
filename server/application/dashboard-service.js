import { notFound, validation } from '../domain/errors.js';
import { runIdempotent } from './idempotency.js';

function required(value, field, max = 10_000) {
  const text = String(value ?? '').trim();
  if (!text) throw validation(`${field} is required`, { field });
  if (text.length > max) throw validation(`${field} is too long`, { field, max });
  return text;
}

export class DashboardService {
  constructor(db, eventStore, projectService, gitAdapter) {
    this.db = db;
    this.events = eventStore;
    this.projects = projectService;
    this.git = gitAdapter;
  }

  #note(row) {
    return {
      ...row,
      tags: this.db.prepare(
        `SELECT tags.id, tags.name, tags.color FROM tags
         JOIN note_tags ON note_tags.tag_id = tags.id
         WHERE note_tags.note_id = ? ORDER BY tags.name`
      ).all(row.id)
    };
  }

  #issue(row) {
    return {
      ...row,
      tags: this.db.prepare(
        `SELECT tags.id, tags.name, tags.color FROM tags
         JOIN issue_tags ON issue_tags.tag_id = tags.id
         WHERE issue_tags.issue_id = ? ORDER BY tags.name`
      ).all(row.id)
    };
  }

  addIssue(projectId, input, context) {
    return runIdempotent(this.db, context, { command: 'dashboard.addIssue', projectId, input }, () => {
      this.projects.get(projectId);
      const title = required(input.title, 'title', 500);
      const kind = input.kind ? required(input.kind, 'kind', 30) : null;
      if (kind && !['bug', 'feature', 'task'].includes(kind)) {
        throw validation('Unknown issue kind', { field: 'kind' });
      }
      let id;
      this.events.append({
        projectId, type: 'issue.created', actor: context.actor,
        correlationId: context.correlationId, payload: { title, branch: input.branch || null, kind }
      }, () => {
        id = Number(this.db.prepare('INSERT INTO issues(project_id, title, branch) VALUES (?, ?, ?)')
          .run(projectId, title, input.branch || null).lastInsertRowid);
        if (kind) {
          this.db.prepare('INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(kind);
          this.db.prepare(
            'INSERT INTO issue_tags(issue_id, tag_id) SELECT ?, id FROM tags WHERE name = ?'
          ).run(id, kind);
        }
      });
      return this.#issue(this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id));
    });
  }

  updateIssue(projectId, issueId, input, context) {
    return runIdempotent(this.db, context, { command: 'dashboard.updateIssue', projectId, issueId, input }, () => {
      const issue = this.db.prepare('SELECT * FROM issues WHERE project_id = ? AND id = ?').get(projectId, issueId);
      if (!issue) throw notFound('Issue', issueId);
      const status = required(input.status, 'status', 30);
      if (!['open', 'in_progress', 'closed'].includes(status)) {
        throw validation('Unknown issue status', { field: 'status' });
      }
      this.events.append({
        projectId, type: 'issue.status.updated', actor: context.actor,
        correlationId: context.correlationId, payload: { issueId, status }
      }, () => this.db.prepare('UPDATE issues SET status = ? WHERE project_id = ? AND id = ?')
        .run(status, projectId, issueId));
      return this.db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    });
  }

  addNote(projectId, input, context) {
    return runIdempotent(this.db, context, { command: 'dashboard.addNote', projectId, input }, () => {
      this.projects.get(projectId);
      const body = required(input.body, 'body');
      const tags = [...new Set((input.tags || []).map((tag) => required(tag, 'tag', 80)))].sort();
      let id;
      this.events.append({
        projectId, type: 'note.created', actor: context.actor,
        correlationId: context.correlationId, payload: { body, tags }
      }, () => {
        id = Number(this.db.prepare('INSERT INTO notes(project_id, body) VALUES (?, ?)').run(projectId, body).lastInsertRowid);
        for (const tag of tags) {
          this.db.prepare('INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(tag);
          this.db.prepare(
            'INSERT INTO note_tags(note_id, tag_id) SELECT ?, id FROM tags WHERE name = ?'
          ).run(id, tag);
        }
      });
      return this.#note(this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
    });
  }

  async syncGit(projectId, context) {
    const project = this.projects.get(projectId);
    const commits = await this.git.history(project.repoPath, project.baseBranch, 100);
    const fileTree = await this.git.fileTree(project.repoPath).catch(() => []);
    const headSha = commits[0]?.hash || '';
    const result = runIdempotent(this.db, context, { command: 'dashboard.syncGit', projectId }, () => {
      this.events.append({
        projectId, type: 'git.history.observed', actor: context.actor,
        correlationId: context.correlationId, payload: { branch: project.baseBranch, count: commits.length }
      }, () => {
        const insert = this.db.prepare(
          `INSERT INTO git_events(project_id, commit_hash, author, message, branch, committed_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, commit_hash) DO UPDATE SET
           author = excluded.author, message = excluded.message, branch = excluded.branch,
           committed_at = excluded.committed_at`
        );
        for (const commit of commits) insert.run(projectId, commit.hash, commit.author, commit.message, project.baseBranch, commit.committedAt);
      });
      return this.db.prepare('SELECT * FROM git_events WHERE project_id = ? ORDER BY committed_at DESC LIMIT 100').all(projectId);
    });
    this.#refreshDigest(projectId, headSha, fileTree);
    return result;
  }

  #refreshDigest(projectId, headSha, fileTree) {
    const milestones = this.db.prepare(
      `SELECT display_key, title, description FROM timeline_nodes
       WHERE project_id = ? AND kind = 'milestone' ORDER BY ordinal`
    ).all(projectId);
    this.db.prepare(
      `INSERT INTO project_digests(project_id, head_sha, file_tree_json, milestones_json, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(project_id) DO UPDATE SET
       head_sha = excluded.head_sha, file_tree_json = excluded.file_tree_json,
       milestones_json = excluded.milestones_json, updated_at = excluded.updated_at`
    ).run(projectId, headSha, JSON.stringify(fileTree), JSON.stringify(milestones));
  }

  getDigest(projectId) {
    return this.db.prepare('SELECT * FROM project_digests WHERE project_id = ?').get(projectId) || null;
  }

  async #gitStatus(project) {
    try {
      const state = await this.git.inspect(project.repoPath);
      return { branch: state.branch, headSha: state.headSha, dirty: state.dirty };
    } catch {
      return { branch: null, headSha: null, dirty: false };
    }
  }

  async branches(projectId) {
    const project = this.projects.get(projectId);
    try {
      return await this.git.branches(project.repoPath);
    } catch {
      return [];
    }
  }

  async #changedFiles(project, gitEvents) {
    const baseSha = gitEvents[0]?.commit_hash;
    if (!baseSha) return [];
    try {
      return await this.git.changedFiles({ worktreePath: project.repoPath, baseSha });
    } catch {
      return [];
    }
  }

  async summary(projectId) {
    const project = this.projects.get(projectId);
    const timelineCounts = Object.fromEntries(this.db.prepare(
      `SELECT status, COUNT(*) AS count FROM timeline_nodes
       WHERE project_id = ? AND kind = 'step' GROUP BY status`
    ).all(projectId).map((row) => [row.status, row.count]));
    const issues = this.db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY id DESC').all(projectId);
    const gitEvents = this.db.prepare('SELECT * FROM git_events WHERE project_id = ? ORDER BY committed_at DESC LIMIT 100').all(projectId);
    const [gitStatus, changedFiles] = await Promise.all([
      this.#gitStatus(project),
      this.#changedFiles(project, gitEvents)
    ]);
    return {
      metrics: {
        activeRuns: this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE project_id = ? AND status IN ('starting','running')").get(projectId).count,
        blockedGates: this.db.prepare("SELECT COUNT(*) AS count FROM gates WHERE project_id = ? AND blocking = 1 AND status != 'passed'").get(projectId).count,
        reviewQueue: this.db.prepare("SELECT COUNT(*) AS count FROM timeline_nodes WHERE project_id = ? AND status = 'review'").get(projectId).count,
        openIssues: issues.filter((issue) => issue.status !== 'closed').length
      },
      timelineCounts,
      issues,
      notes: this.db.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY id DESC').all(projectId).map((row) => this.#note(row)),
      gitEvents,
      gitStatus,
      changedFiles,
      activity: this.db.prepare('SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 100').all(projectId)
    };
  }
}
