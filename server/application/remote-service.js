import { AppError } from '../domain/errors.js';
import { runIdempotent } from './idempotency.js';

export class RemoteService {
  constructor(db, eventStore, projectService, gitAdapter, remoteAdapter, config) {
    this.db = db;
    this.events = eventStore;
    this.projects = projectService;
    this.git = gitAdapter;
    this.remote = remoteAdapter;
    this.config = config;
  }

  get repo() {
    return this.remote;
  }

  #configured() {
    return Boolean(this.config.githubToken);
  }

  #originFor(project) {
    return this.git.remoteOrigin(project.repoPath);
  }

  async syncPullRequests(projectId, context) {
    const project = this.projects.get(projectId);
    if (!this.#configured()) {
      throw new AppError('REMOTE_NOT_CONFIGURED', 'GATE_GITHUB_TOKEN is not set. Configure it in a .env file or environment variable.', {
        status: 503
      });
    }
    const origin = await this.#originFor(project);
    if (!origin) {
      throw new AppError('REMOTE_UNKNOWN', 'The repository has no GitHub remote configured', { status: 422 });
    }
    const remote = this.remote.resolve(project.repoPath, origin);
    const pulls = await this.remote.listPullRequests(remote.owner, remote.repo);
    return runIdempotent(this.db, context, { command: 'remote.syncPullRequests', projectId }, () => {
      this.events.append({
        projectId,
        type: 'remote.prs.observed',
        actor: context.actor,
        correlationId: context.correlationId,
        payload: { owner: remote.owner, repo: remote.repo, count: pulls.length }
      }, () => {
        const upsert = this.db.prepare(
          `INSERT INTO remote_prs(project_id, number, title, state, draft, head_ref, base_ref, author, body, html_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, number) DO UPDATE SET
             title = excluded.title, state = excluded.state, draft = excluded.draft,
             head_ref = excluded.head_ref, base_ref = excluded.base_ref, author = excluded.author,
             body = excluded.body, html_url = excluded.html_url, updated_at = excluded.updated_at`
        );
        for (const pull of pulls) {
          upsert.run(
            projectId, pull.number, pull.title, pull.state, pull.draft ? 1 : 0,
            pull.headRef, pull.baseRef, pull.author, pull.body, pull.htmlUrl, pull.updatedAt
          );
        }
      });
      return this.pullRequests(projectId);
    });
  }

  async syncIssues(projectId, context) {
    const project = this.projects.get(projectId);
    if (!this.#configured()) {
      throw new AppError('REMOTE_NOT_CONFIGURED', 'GATE_GITHUB_TOKEN is not set. Configure it in a .env file or environment variable.', {
        status: 503
      });
    }
    const origin = await this.#originFor(project);
    if (!origin) {
      throw new AppError('REMOTE_UNKNOWN', 'The repository has no GitHub remote configured', { status: 422 });
    }
    const remote = this.remote.resolve(project.repoPath, origin);
    const issues = await this.remote.listIssues(remote.owner, remote.repo);
    return runIdempotent(this.db, context, { command: 'remote.syncIssues', projectId }, () => {
      this.events.append({
        projectId,
        type: 'remote.issues.observed',
        actor: context.actor,
        correlationId: context.correlationId,
        payload: { owner: remote.owner, repo: remote.repo, count: issues.length }
      }, () => {
        const upsert = this.db.prepare(
          `INSERT INTO remote_issues(project_id, number, title, state, labels_json, assignee, html_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, number) DO UPDATE SET
             title = excluded.title, state = excluded.state, labels_json = excluded.labels_json,
             assignee = excluded.assignee, html_url = excluded.html_url, updated_at = excluded.updated_at`
        );
        for (const issue of issues) {
          upsert.run(
            projectId, issue.number, issue.title, issue.state,
            JSON.stringify(issue.labels), issue.assignee, issue.htmlUrl, issue.updatedAt
          );
        }
      });
      return this.issues(projectId);
    });
  }

  async sync(projectId, context) {
    const project = this.projects.get(projectId);
    if (!this.#configured()) {
      throw new AppError('REMOTE_NOT_CONFIGURED', 'GATE_GITHUB_TOKEN is not set. Configure it in a .env file or environment variable.', {
        status: 503
      });
    }
    const origin = await this.#originFor(project);
    if (!origin) {
      throw new AppError('REMOTE_UNKNOWN', 'The repository has no GitHub remote configured', { status: 422 });
    }
    const remote = this.remote.resolve(project.repoPath, origin);
    const [pulls, issues] = await Promise.all([
      this.remote.listPullRequests(remote.owner, remote.repo),
      this.remote.listIssues(remote.owner, remote.repo)
    ]);
    return runIdempotent(this.db, context, { command: 'remote.sync', projectId }, () => {
      this.events.append({
        projectId,
        type: 'remote.prs.observed',
        actor: context.actor,
        correlationId: context.correlationId,
        payload: { owner: remote.owner, repo: remote.repo, count: pulls.length }
      }, () => {
        const upsert = this.db.prepare(
          `INSERT INTO remote_prs(project_id, number, title, state, draft, head_ref, base_ref, author, body, html_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, number) DO UPDATE SET
             title = excluded.title, state = excluded.state, draft = excluded.draft,
             head_ref = excluded.head_ref, base_ref = excluded.base_ref, author = excluded.author,
             body = excluded.body, html_url = excluded.html_url, updated_at = excluded.updated_at`
        );
        for (const pull of pulls) {
          upsert.run(
            projectId, pull.number, pull.title, pull.state, pull.draft ? 1 : 0,
            pull.headRef, pull.baseRef, pull.author, pull.body, pull.htmlUrl, pull.updatedAt
          );
        }
      });
      this.events.append({
        projectId,
        type: 'remote.issues.observed',
        actor: context.actor,
        correlationId: context.correlationId,
        payload: { owner: remote.owner, repo: remote.repo, count: issues.length }
      }, () => {
        const upsert = this.db.prepare(
          `INSERT INTO remote_issues(project_id, number, title, state, labels_json, assignee, html_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, number) DO UPDATE SET
             title = excluded.title, state = excluded.state, labels_json = excluded.labels_json,
             assignee = excluded.assignee, html_url = excluded.html_url, updated_at = excluded.updated_at`
        );
        for (const issue of issues) {
          upsert.run(
            projectId, issue.number, issue.title, issue.state,
            JSON.stringify(issue.labels), issue.assignee, issue.htmlUrl, issue.updatedAt
          );
        }
      });
      return { prs: this.pullRequests(projectId), issues: this.issues(projectId) };
    });
  }

  pullRequests(projectId) {
    const rows = this.db.prepare(
      'SELECT * FROM remote_prs WHERE project_id = ? ORDER BY updated_at DESC, number DESC'
    ).all(projectId);
    return rows.map((row) => ({
      number: row.number,
      title: row.title,
      state: row.state,
      draft: Boolean(row.draft),
      headRef: row.head_ref,
      baseRef: row.base_ref,
      author: row.author,
      body: row.body,
      htmlUrl: row.html_url,
      updatedAt: row.updated_at
    }));
  }

  issues(projectId) {
    const rows = this.db.prepare(
      'SELECT * FROM remote_issues WHERE project_id = ? ORDER BY updated_at DESC, number DESC'
    ).all(projectId);
    return rows.map((row) => ({
      number: row.number,
      title: row.title,
      state: row.state,
      labels: JSON.parse(row.labels_json),
      assignee: row.assignee,
      htmlUrl: row.html_url,
      updatedAt: row.updated_at
    }));
  }

  status(projectId) {
    this.projects.get(projectId);
    return {
      configured: this.#configured(),
      prCount: this.db.prepare('SELECT COUNT(*) AS count FROM remote_prs WHERE project_id = ?').get(projectId).count,
      issueCount: this.db.prepare('SELECT COUNT(*) AS count FROM remote_issues WHERE project_id = ?').get(projectId).count
    };
  }
}
