import { AppError } from '../../domain/errors.js';

function parseOrigin(originUrl) {
  const url = String(originUrl || '').trim();
  if (!url) return null;
  const https = /^https?:\/\/([^/]+)\/([^/]+)\/([^/.]+)(?:\.git)?\/?$/.exec(url);
  if (https) {
    return { host: https[1], owner: https[2], repo: https[3] };
  }
  const scp = /^(?:git@|ssh:\/\/git@)?[^:/]+[:\/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  if (scp) {
    return { host: url.includes('@') ? url.split('@')[1].split(':')[0] : url.split('/')[0], owner: scp[1], repo: scp[2] };
  }
  const githubCom = /^github\.com[:\/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  if (githubCom) {
    return { host: 'github.com', owner: githubCom[1], repo: githubCom[2] };
  }
  return null;
}

export class GithubRemoteAdapter {
  constructor({ token = '', apiUrl = 'https://api.github.com' } = {}) {
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, '');
  }

  async #get(path, params = {}) {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new AppError('REMOTE_UNAUTHORIZED', 'GitHub authentication failed. Set GATE_GITHUB_TOKEN in a .env file or environment.', {
          status: 503
        });
      }
      if (status === 404) {
        throw new AppError('REMOTE_NOT_FOUND', 'Repository was not found on GitHub', { status: 503 });
      }
      throw new AppError('REMOTE_ERROR', `GitHub returned ${status}`, { status: 503 });
    }
    return response.json();
  }

  resolve(repoPath, origin) {
    const remote = parseOrigin(origin);
    if (!remote) {
      throw new AppError('REMOTE_UNKNOWN', 'Could not determine the GitHub repository from the origin URL', {
        status: 422,
        details: { repoPath }
      });
    }
    return remote;
  }

  async listPullRequests(owner, repo) {
    const pulls = await this.#get(`/repos/${owner}/${repo}/pulls`, {
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 50
    });
    return (Array.isArray(pulls) ? pulls : []).map((pull) => ({
      number: pull.number,
      title: pull.title,
      state: pull.state || 'open',
      draft: Boolean(pull.draft),
      headRef: pull.head?.ref || '',
      baseRef: pull.base?.ref || '',
      author: pull.user?.login || null,
      body: pull.body || null,
      htmlUrl: pull.html_url || null,
      updatedAt: pull.updated_at || null
    }));
  }

  async listIssues(owner, repo) {
    const issues = await this.#get(`/repos/${owner}/${repo}/issues`, {
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 50
    });
    return (Array.isArray(issues) ? issues : [])
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state || 'open',
        labels: (issue.labels || []).map((label) => label.name || label),
        assignee: issue.assignee?.login || null,
        htmlUrl: issue.html_url || null,
        updatedAt: issue.updated_at || null
      }));
  }
}
