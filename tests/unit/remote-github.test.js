import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GithubRemoteAdapter } from '../../server/adapters/remote/github.js';

function adapterWithFetch(handler) {
  const adapter = new GithubRemoteAdapter({ token: 'test-token' });
  adapter._fetch = globalThis.fetch;
  globalThis.fetch = handler;
  return adapter;
}

test('resolve parses an https origin URL', () => {
  const adapter = new GithubRemoteAdapter({});
  const remote = adapter.resolve('/tmp/repo', 'https://github.com/T-Crypt/GATE.git');
  assert.deepEqual(remote, { host: 'github.com', owner: 'T-Crypt', repo: 'GATE' });
});

test('resolve parses a git scp-style origin URL', () => {
  const adapter = new GithubRemoteAdapter({});
  const remote = adapter.resolve('/tmp/repo', 'git@github.com:T-Crypt/GATE.git');
  assert.equal(remote.owner, 'T-Crypt');
  assert.equal(remote.repo, 'GATE');
});

test('resolve throws for a non-GitHub origin', () => {
  const adapter = new GithubRemoteAdapter({});
  assert.throws(
    () => adapter.resolve('/tmp/repo', ''),
    (error) => error.code === 'REMOTE_UNKNOWN'
  );
});

test('listPullRequests maps GitHub response objects', async () => {
  let requestedHeaders = null;
  const adapter = adapterWithFetch(async (url) => {
    requestedHeaders = url;
    return {
      ok: true,
      json: async () => [
        {
          number: 9,
          title: 'Add remote observation',
          state: 'open',
          draft: false,
          head: { ref: 'feat/remote' },
          base: { ref: 'main' },
          user: { login: 'author-1' },
          body: 'body',
          html_url: 'https://github.com/o/r/pull/9',
          updated_at: '2026-09-08T00:00:00Z'
        }
      ]
    };
  });

  try {
    const pulls = await adapter.listPullRequests('o', 'r');
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].number, 9);
    assert.equal(pulls[0].headRef, 'feat/remote');
    assert.equal(pulls[0].baseRef, 'main');
    assert.equal(pulls[0].author, 'author-1');
    assert.match(requestedHeaders, /\/repos\/o\/r\/pulls/);
  } finally {
    globalThis.fetch = adapter._fetch;
  }
});

test('listIssues filters out pull requests', async () => {
  const adapter = adapterWithFetch(async () => ({
    ok: true,
    json: async () => [
      { number: 1, title: 'Real issue', state: 'open', labels: [], assignee: null, html_url: '', updated_at: '' },
      { number: 2, title: 'A PR', pull_request: {}, state: 'open' }
    ]
  }));

  try {
    const issues = await adapter.listIssues('o', 'r');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].number, 1);
  } finally {
    globalThis.fetch = adapter._fetch;
  }
});