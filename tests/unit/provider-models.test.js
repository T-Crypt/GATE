import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClaudeProvider } from '../../server/adapters/providers/claude.js';
import { OpenCodeProvider } from '../../server/adapters/providers/opencode.js';

class FakeRunner {
  constructor({ stdout = '', exitCode = 0 } = {}) {
    this.stdout = stdout;
    this.exitCode = exitCode;
    this.requests = [];
  }

  async start(request, observer) {
    this.requests.push(request);
    if (this.stdout) observer.onOutput?.(this.stdout, 'stdout');
    return { completion: Promise.resolve({ exitCode: this.exitCode, signal: null }), cancel: async () => {} };
  }
}

test('opencode reports the models its CLI lists', async () => {
  const runner = new FakeRunner({ stdout: 'opencode/big-pickle\nopencode/mimo-v2.5-free\n' });
  const catalog = await new OpenCodeProvider({ executable: 'opencode', runner, env: {}, platform: 'linux' }).listModels();
  assert.deepEqual(runner.requests[0].args, ['models']);
  assert.equal(catalog.authenticated, true);
  assert.deepEqual(catalog.models.map((model) => model.id), ['opencode/big-pickle', 'opencode/mimo-v2.5-free']);
});

test('opencode reports no models when its CLI fails', async () => {
  const runner = new FakeRunner({ exitCode: 1 });
  const catalog = await new OpenCodeProvider({ executable: 'opencode', runner, env: {}, platform: 'linux' }).listModels();
  assert.deepEqual(catalog, { authenticated: false, models: [] });
});

test('claude reports aliases and its auth state', async () => {
  const runner = new FakeRunner({ stdout: 'Logged in\n' });
  const catalog = await new ClaudeProvider({ executable: 'claude', runner }).listModels();
  assert.deepEqual(runner.requests[0].args, ['auth', 'status']);
  assert.equal(catalog.authenticated, true);
  assert.deepEqual(catalog.models.map((model) => model.id), ['opus', 'sonnet', 'haiku']);
});

test('claude surfaces the CLI reason instead of a generic failure', async () => {
  const runner = new FakeRunner({
    stdout: JSON.stringify({
      is_error: true,
      result: 'There\'s an issue with the selected model (Sonnet 5). It may not exist or you may not have access to it.'
    }),
    exitCode: 1
  });
  const provider = new ClaudeProvider({ executable: 'claude', runner });
  await assert.rejects(
    () => provider.draftTimeline({ goal: 'x', repositoryContext: 'y', cwd: '/tmp', model: 'Sonnet 5' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_FAILED');
      assert.match(error.message, /Sonnet 5/);
      assert.equal(error.details.exitCode, 1);
      return true;
    }
  );
});
