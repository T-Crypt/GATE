import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { CodexProvider } from '../../server/adapters/providers/codex.js';
import { CopilotProvider, hasCredentials as copilotCredentials } from '../../server/adapters/providers/copilot.js';
import { CursorProvider } from '../../server/adapters/providers/cursor.js';
import { GeminiProvider, hasCredentials as geminiCredentials } from '../../server/adapters/providers/gemini.js';
import { createLineReader, parseTimelineJson, stripCodeFence } from '../../server/adapters/providers/cli-support.js';

const GRAPH = {
  nodes: [
    { id: 'm', key: 'M1', kind: 'milestone', title: 'Ship it', parentId: null, ordinal: 0 },
    { id: 's', key: 'M1.1', kind: 'step', title: 'Do the work', parentId: 'm', ordinal: 0 }
  ],
  edges: [],
  gates: []
};

class FakeRunner {
  constructor({ stdout = '', stderr = '', exitCode = 0, onStart } = {}) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.onStart = onStart;
    this.requests = [];
  }

  async start(request, observer) {
    this.requests.push(request);
    await this.onStart?.(request);
    if (this.stdout) observer?.onOutput?.(this.stdout, 'stdout');
    if (this.stderr) observer?.onOutput?.(this.stderr, 'stderr');
    return {
      completion: Promise.resolve({ exitCode: this.exitCode, signal: null }),
      cancel: async () => {}
    };
  }

  get lastArgs() {
    return this.requests.at(-1).args;
  }
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const draftRequest = { goal: 'Ship it', repositoryContext: 'a repo', cwd: '/tmp', env: {} };

// --- shared plumbing -------------------------------------------------------

test('parseTimelineJson unwraps a fenced object and names the provider that failed', () => {
  assert.deepEqual(parseTimelineJson('```json\n{"nodes":[]}\n```', 'Codex'), { nodes: [] });
  assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}');
  assert.throws(() => parseTimelineJson('not json', 'Gemini'), (error) => {
    assert.equal(error.code, 'PROVIDER_OUTPUT_INVALID');
    assert.match(error.message, /Gemini/);
    return true;
  });
  assert.throws(() => parseTimelineJson('{}', 'Cursor'), (error) => {
    assert.equal(error.code, 'PROVIDER_OUTPUT_INCOMPLETE');
    return true;
  });
  assert.throws(() => parseTimelineJson(undefined, 'Copilot'), (error) => {
    assert.equal(error.code, 'PROVIDER_OUTPUT_INCOMPLETE');
    return true;
  });
});

test('createLineReader reassembles events split across chunk boundaries', () => {
  const seen = [];
  const read = createLineReader((event) => seen.push(event));
  read('{"type":"a"}\n{"ty');
  read('pe":"b"}\nnot json\n{"type":"c"}\n');
  assert.deepEqual(seen.map((event) => event.type), ['a', 'b', 'c']);
});

// --- codex -----------------------------------------------------------------

test('codex drafts through --output-schema and reads the constrained answer back', async () => {
  const runner = new FakeRunner({
    stdout: 'thinking…\n',
    onStart: async (request) => {
      // Codex writes the schema-constrained answer to the file named by
      // --output-last-message, not to stdout.
      await fs.writeFile(argValue(request.args, '--output-last-message'), JSON.stringify(GRAPH), 'utf8');
    }
  });
  const provider = new CodexProvider({ runner });
  const graph = await provider.draftTimeline({ ...draftRequest, model: 'gpt-6-astra' });

  assert.deepEqual(graph, GRAPH);
  const args = runner.lastArgs;
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), '-', 'the prompt must arrive on stdin, not the command line');
  assert.equal(argValue(args, '--sandbox'), 'read-only', 'drafting must not be able to write');
  assert.equal(argValue(args, '--model'), 'gpt-6-astra');
  assert.equal(runner.requests[0].input.includes('Ship it'), true);

  const schema = JSON.parse(await fs.readFile(argValue(args, '--output-schema'), 'utf8').catch(() => '{}'));
  assert.equal(schema.required, undefined, 'the scratch directory is removed once the draft resolves');
});

test('codex cleans up its scratch directory even when the CLI fails', async () => {
  const before = (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith('gate-codex-')).length;
  const runner = new FakeRunner({ exitCode: 1, stdout: 'model "nope" is not available\n' });
  await assert.rejects(
    () => new CodexProvider({ runner }).draftTimeline(draftRequest),
    (error) => {
      assert.equal(error.code, 'PROVIDER_FAILED');
      assert.match(error.message, /nope/);
      return true;
    }
  );
  const after = (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith('gate-codex-')).length;
  assert.equal(after, before);
});

test('codex runs execution in a workspace-write sandbox and surfaces agent messages', async () => {
  const runner = new FakeRunner({
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-7' }),
      // `type` is the SDK's discriminator. The adapter still reads `item_type`
      // for older builds, but a fixture that only exercised the fallback let the
      // real shape break while the suite stayed green.
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'unknown_future_kind' } }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'context exhausted' } })
    ].join('\n') + '\n',
    stderr: 'progress\n'
  });
  const chunks = [];
  const session = await new CodexProvider({ runner }).start(
    { prompt: 'step', cwd: '/tmp' },
    { onOutput: (chunk, stream) => chunks.push([stream, chunk]) }
  );
  await session.completion;

  assert.equal(session.sessionId, 'thread-7', 'the codex thread id is the resumable session handle');
  assert.equal(argValue(runner.lastArgs, '--sandbox'), 'workspace-write');
  assert.deepEqual(chunks, [
    ['stdout', '$ npm test\n'],
    ['stdout', 'done\n'],
    ['stdout', '[codex error] context exhausted\n'],
    ['stderr', 'progress\n']
  ]);
});

test('codex reports an incomplete catalog so any model id is accepted', async () => {
  const runner = new FakeRunner({ stdout: 'Logged in\n' });
  const catalog = await new CodexProvider({ runner }).listModels();
  assert.deepEqual(runner.lastArgs, ['login', 'status']);
  assert.equal(catalog.authenticated, true);
  assert.equal(catalog.complete, false);
  assert.deepEqual(catalog.models, []);
});

// --- gemini ----------------------------------------------------------------

test('gemini unwraps the json envelope around its answer', async () => {
  const runner = new FakeRunner({ stdout: JSON.stringify({ response: JSON.stringify(GRAPH), stats: {} }) });
  const graph = await new GeminiProvider({ runner }).draftTimeline(draftRequest);
  assert.deepEqual(graph, GRAPH);
  assert.equal(argValue(runner.lastArgs, '--output-format'), 'json');
  assert.equal(argValue(runner.lastArgs, '--approval-mode'), 'default', 'drafting must not get write access');
  assert.equal(argValue(runner.lastArgs, '--model'), 'auto');
});

test('gemini surfaces the error inside its envelope', async () => {
  const runner = new FakeRunner({ stdout: JSON.stringify({ error: { message: 'quota exhausted' } }) });
  await assert.rejects(
    () => new GeminiProvider({ runner }).draftTimeline(draftRequest),
    (error) => {
      assert.equal(error.code, 'PROVIDER_FAILED');
      assert.match(error.message, /quota exhausted/);
      return true;
    }
  );
});

test('gemini execution approves tools inside the worktree', async () => {
  const runner = new FakeRunner({
    stdout: [
      // The CLI replays the resolved prompt as a user-role event before any
      // model output. Forwarding it showed the operator Gate's own prompt.
      JSON.stringify({ type: 'message', role: 'user', content: 'the entire step prompt' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'work', delta: true }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'ing', delta: true })
    ].join('\n') + '\n'
  });
  const chunks = [];
  const session = await new GeminiProvider({ runner }).start(
    { prompt: 'step', cwd: '/tmp', model: 'gemini-3-pro-preview' },
    { onOutput: (chunk) => chunks.push(chunk) }
  );
  await session.completion;
  assert.equal(argValue(runner.lastArgs, '--approval-mode'), 'yolo');
  assert.equal(argValue(runner.lastArgs, '--model'), 'gemini-3-pro-preview');
  // Incremental chunks are forwarded verbatim; a newline per chunk would have
  // broken every assistant sentence across several lines.
  assert.deepEqual(chunks, ['work', 'ing']);
});

test('gemini treats an api key or stored oauth credentials as signed in', () => {
  assert.equal(geminiCredentials({ env: { GEMINI_API_KEY: 'k' }, existsSync: () => false }), true);
  assert.equal(geminiCredentials({ env: { GOOGLE_API_KEY: 'k' }, existsSync: () => false }), true);
  assert.equal(geminiCredentials({ env: {}, homeDir: '/home/x', existsSync: () => true }), true);
  assert.equal(geminiCredentials({ env: {}, homeDir: '/home/x', existsSync: () => false }), false);
  // The CLI resolves its own home through this override before the OS home.
  assert.equal(
    geminiCredentials({
      env: { GEMINI_CLI_HOME: '/custom' },
      homeDir: '/home/x',
      existsSync: (candidate) => candidate === '/custom/.gemini/oauth_creds.json'
    }),
    true
  );
});

test('gemini reports signed out when the CLI is present but has no credentials', async () => {
  const runner = new FakeRunner({ stdout: '0.21.1\n' });
  const catalog = await new GeminiProvider({ runner, env: {} }).listModels();
  assert.equal(catalog.authenticated, false);
  assert.equal(catalog.complete, false);
  assert.equal(catalog.models.some((model) => model.id === 'auto'), true);
});

// --- cursor ----------------------------------------------------------------

test('cursor lists the models its CLI reports', async () => {
  const runner = new FakeRunner({ stdout: '* sonnet-4.5\ngpt-5.5\nnot a model id\n' });
  const catalog = await new CursorProvider({ runner }).listModels();
  assert.deepEqual(runner.lastArgs, ['models']);
  assert.equal(catalog.authenticated, true);
  assert.notEqual(catalog.complete, false, 'an enumerated catalog is authoritative');
  assert.deepEqual(catalog.models.map((model) => model.id), ['sonnet-4.5', 'gpt-5.5']);
});

test('cursor drafts in print mode without --force and unwraps the result envelope', async () => {
  const runner = new FakeRunner({
    stdout: JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(GRAPH) })
  });
  const graph = await new CursorProvider({ runner }).draftTimeline(draftRequest);
  assert.deepEqual(graph, GRAPH);
  assert.equal(runner.lastArgs.includes('--print'), true);
  assert.equal(runner.lastArgs.includes('--force'), false, 'drafting must not approve commands');
  assert.equal(argValue(runner.lastArgs, '--output-format'), 'json');
  // The prompt is the documented positional argument; piped stdin only makes
  // print mode inferred, it is not read as the prompt.
  assert.match(runner.lastArgs.at(-1), /Ship it/);
  assert.equal(runner.requests[0].input, undefined);
});

test('cursor surfaces an errored result envelope', async () => {
  const runner = new FakeRunner({ stdout: JSON.stringify({ type: 'result', is_error: true, result: 'not signed in' }) });
  await assert.rejects(
    () => new CursorProvider({ runner }).draftTimeline(draftRequest),
    (error) => {
      assert.equal(error.code, 'PROVIDER_FAILED');
      assert.match(error.message, /not signed in/);
      return true;
    }
  );
});

test('cursor execution streams assistant text and keeps the reported session id', async () => {
  const runner = new FakeRunner({
    stdout: [
      JSON.stringify({ type: 'system', session_id: 'sess-3' }),
      // Each call is keyed by its own field; there is no flat `name`.
      JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { writeToolCall: { args: {} } } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ text: 'patched' }] } })
    ].join('\n') + '\n'
  });
  const chunks = [];
  const session = await new CursorProvider({ runner }).start(
    { prompt: 'step', cwd: '/tmp' },
    { onOutput: (chunk) => chunks.push(chunk) }
  );
  await session.completion;
  assert.equal(session.sessionId, 'sess-3');
  assert.equal(runner.lastArgs.includes('--force'), true);
  assert.equal(runner.lastArgs.at(-1), 'step');
  assert.deepEqual(chunks, ['· writeToolCall\n', 'patched\n']);
});

// --- copilot ---------------------------------------------------------------

test('copilot drafts without tool access and tolerates a fenced answer', async () => {
  const runner = new FakeRunner({ stdout: `\`\`\`json\n${JSON.stringify(GRAPH)}\n\`\`\`` });
  const graph = await new CopilotProvider({ runner }).draftTimeline(draftRequest);
  assert.deepEqual(graph, GRAPH);
  assert.equal(runner.lastArgs.includes('--allow-all-tools'), false, 'drafting must get no shell and no writes');
  assert.equal(runner.lastArgs.includes('--no-ask-user'), true, 'a headless CLI must never block on a question');
  // The prompt goes on stdin: `-p` would make Copilot ignore stdin, and a
  // multi-KB prompt on the command line truncates at Windows' ~32 KB ceiling.
  assert.equal(runner.lastArgs.includes('-p'), false);
  assert.match(runner.requests[0].input, /Ship it/);
});

test('copilot execution allows tools inside the worktree', async () => {
  const runner = new FakeRunner({ stdout: 'done\n' });
  const session = await new CopilotProvider({ runner }).start({ prompt: 'step body', cwd: '/tmp' }, {});
  await session.completion;
  assert.equal(runner.lastArgs.includes('--allow-all-tools'), true);
  assert.equal(runner.lastArgs.includes('-p'), false);
  assert.equal(runner.requests[0].input, 'step body');
});

test('copilot reads its token from the documented environment variables', async () => {
  assert.equal(copilotCredentials({ COPILOT_GITHUB_TOKEN: 't' }), true);
  assert.equal(copilotCredentials({ GH_TOKEN: 't' }), true);
  assert.equal(copilotCredentials({ GITHUB_TOKEN: 't' }), true);
  assert.equal(copilotCredentials({}), false);

  const runner = new FakeRunner({ stdout: '1.0.0\n' });
  const catalog = await new CopilotProvider({ runner, env: { GH_TOKEN: 't' } }).listModels();
  assert.equal(catalog.authenticated, true);
  assert.equal(catalog.complete, false);
});

// --- registration ----------------------------------------------------------

test('every shipped adapter satisfies the provider contract', async () => {
  const { buildServices } = await import('../../server/composition.js');
  const { createTestDatabase } = await import('../helpers/database.js');
  const database = createTestDatabase();
  try {
    const { providers } = buildServices({
      db: database.db,
      config: { outputLimitBytes: 1000, worktreeDir: path.join(os.tmpdir(), 'gate-test-worktrees') }
    });
    assert.deepEqual([...providers.keys()], ['claude', 'opencode', 'codex', 'gemini', 'cursor', 'copilot']);
    for (const [kind, provider] of providers) {
      assert.equal(typeof provider.start, 'function', `${kind} must implement start`);
      assert.equal(typeof provider.draftTimeline, 'function', `${kind} must implement draftTimeline`);
      assert.equal(typeof provider.listModels, 'function', `${kind} must implement listModels`);
      const capabilities = provider.capabilities();
      assert.equal(typeof capabilities.structuredDrafts, 'boolean', `${kind} must declare capabilities`);
      assert.equal(typeof capabilities.streaming, 'boolean', `${kind} must declare capabilities`);
      // Dropped deliberately: Gate resumes no run, and `listModels().complete`
      // already reports whether a catalog can be enumerated.
      assert.deepEqual(Object.keys(capabilities).sort(), ['streaming', 'structuredDrafts']);
    }
  } finally {
    database.close?.();
  }
});
