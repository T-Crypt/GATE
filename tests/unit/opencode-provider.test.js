import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AppError } from '../../server/domain/errors.js';
import { OpenCodeProvider, resolveExecutable } from '../../server/adapters/providers/opencode.js';

const DEFAULT_MODEL = 'opencode/big-pickle';

function ndjson(event) {
  return `${JSON.stringify(event)}\n`;
}

function textEvent(sessionID, text) {
  return {
    type: 'text',
    timestamp: 1,
    sessionID,
    part: { type: 'text', text, time: { start: 0, end: 1 } }
  };
}

class FakeRunner {
  constructor({ lines = [], exitCode = 0 } = {}) {
    this.lines = lines;
    this.exitCode = exitCode;
    this.request = null;
  }

  async start(request, observer) {
    this.request = request;
    for (const line of this.lines) {
      observer.onOutput?.(line, 'stdout');
      observer.onOutput?.('', 'stdout');
    }
    return {
      completion: Promise.resolve({ exitCode: this.exitCode, signal: null }),
      cancel: async () => {}
    };
  }
}

function unitProvider(runner, model) {
  return new OpenCodeProvider({
    executable: 'opencode',
    runner,
    env: {},
    platform: 'linux'
  });
}

const timelineAnswer = {
  nodes: [{ id: 'm', key: 'A', kind: 'milestone', title: 'Build', ordinal: 0 }],
  edges: [],
  gates: []
};

test('draftTimeline parses the last text event and ignores the echoed prompt', async () => {
  const prompt = 'Build a login page';
  const runner = new FakeRunner({
    lines: [
      ndjson(textEvent('ses_1', prompt)),
      ndjson({ type: 'reasoning', timestamp: 2, sessionID: 'ses_1', part: { type: 'reasoning', text: 'thinking' } }),
      ndjson(textEvent('ses_1', 'not the answer')),
      ndjson(textEvent('ses_1', `\`\`\`json\n${JSON.stringify(timelineAnswer)}\n\`\`\``))
    ]
  });
  const provider = unitProvider(runner);

  const graph = await provider.draftTimeline({ goal: 'login', cwd: '/repo', model: DEFAULT_MODEL });

  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].key, 'A');
  assert.equal(runner.request.args[0], 'run');
  assert.ok(runner.request.args.includes('--model'));
  assert.ok(runner.request.args.includes(DEFAULT_MODEL));
  assert.equal(JSON.parse(runner.request.env.OPENCODE_PERMISSION).bash, 'deny');
});

test('draftTimeline tolerates a bare (unfenced) JSON answer', async () => {
  const runner = new FakeRunner({
    lines: [ndjson(textEvent('ses_1', JSON.stringify(timelineAnswer)))]
  });
  const graph = await unitProvider(runner).draftTimeline({ goal: 'login', cwd: '/repo' });
  assert.equal(graph.nodes.length, 1);
});

test('draftTimeline rejects invalid JSON with PROVIDER_OUTPUT_INVALID', async () => {
  const runner = new FakeRunner({ lines: [ndjson(textEvent('ses_1', 'not json'))] });
  await assert.rejects(
    () => unitProvider(runner).draftTimeline({ goal: 'login', cwd: '/repo' }),
    (error) => error.code === 'PROVIDER_OUTPUT_INVALID'
  );
});

test('draftTimeline rejects an empty object with PROVIDER_OUTPUT_INCOMPLETE', async () => {
  const runner = new FakeRunner({ lines: [ndjson(textEvent('ses_1', '{}'))] });
  await assert.rejects(
    () => unitProvider(runner).draftTimeline({ goal: 'login', cwd: '/repo' }),
    (error) => error.code === 'PROVIDER_OUTPUT_INCOMPLETE'
  );
});

test('draftTimeline rejects when no text event was produced', async () => {
  const runner = new FakeRunner({
    lines: [ndjson({ type: 'step-finish', timestamp: 3, sessionID: 'ses_1', part: {} })]
  });
  await assert.rejects(
    () => unitProvider(runner).draftTimeline({ goal: 'login', cwd: '/repo' }),
    (error) => error.code === 'PROVIDER_OUTPUT_INCOMPLETE'
  );
});

test('draftTimeline reports a nonzero exit as PROVIDER_FAILED', async () => {
  const runner = new FakeRunner({ exitCode: 1 });
  await assert.rejects(
    () => unitProvider(runner).draftTimeline({ goal: 'login', cwd: '/repo' }),
    (error) => error.code === 'PROVIDER_FAILED' && error instanceof AppError
  );
});

test('start streams text but filters the echoed prompt and records session id', async () => {
  const prompt = 'Implement the ready step';
  const runner = new FakeRunner({
    lines: [
      ndjson(textEvent('ses_real', prompt)),
      ndjson({ type: 'tool_use', timestamp: 2, sessionID: 'ses_real', part: { type: 'tool_use', tool: 'bash', title: 'Run tests' } }),
      ndjson(textEvent('ses_real', 'done'))
    ]
  });
  const provider = unitProvider(runner);
  const output = [];
  const session = await provider.start(
    {
      runId: 'run-1',
      nodeKey: 'A-1',
      cwd: '/worktree',
      prompt,
      model: DEFAULT_MODEL,
      permissionMode: 'acceptEdits'
    },
    { onOutput: (chunk) => output.push(chunk) }
  );

  assert.equal(session.sessionId, 'ses_real');
  assert.equal(output.join(''), 'done\n');
  assert.ok(runner.request.args.includes('--auto'));
  assert.ok(runner.request.args.includes('--model'));
  assert.equal(runner.request.input, prompt);
});

test('start opts out of --auto for read-only permission modes', async () => {
  const runner = new FakeRunner({ lines: [ndjson(textEvent('s', 'ok'))] });
  const provider = unitProvider(runner);
  await provider.start({ runId: 'run-1', cwd: '/worktree', prompt: 'p', permissionMode: 'deny' }, {});
  assert.ok(!runner.request.args.includes('--auto'));
});

test('start defaults the model when the project sets none', async () => {
  const runner = new FakeRunner({ lines: [ndjson(textEvent('s', 'ok'))] });
  const provider = unitProvider(runner);
  await provider.start({ runId: 'run-1', cwd: '/worktree', prompt: 'p', permissionMode: 'acceptEdits' }, {});
  const index = runner.request.args.indexOf('--model');
  assert.equal(runner.request.args[index + 1], DEFAULT_MODEL);
});

test('start ignores tool and step lifecycle events on the stream', async () => {
  const runner = new FakeRunner({
    lines: [
      ndjson({ type: 'step-start', timestamp: 1, sessionID: 's', part: {} }),
      ndjson({ type: 'step-finish', timestamp: 2, sessionID: 's', part: {} }),
      ndjson(textEvent('s', 'final'))
    ]
  });
  const output = [];
  const provider = unitProvider(runner);
  await provider.start({ runId: 'run-1', cwd: '/worktree', prompt: 'p', permissionMode: 'acceptEdits' }, {
    onOutput: (chunk) => output.push(chunk)
  });
  assert.equal(output.join(''), 'final\n');
});

test('resolveExecutable returns the bare command off Windows', () => {
  assert.equal(resolveExecutable({ executable: 'opencode', platform: 'linux', env: {} }), 'opencode');
});

test('resolveExecutable prefers OPENCODE_BIN_PATH on Windows', () => {
  const resolved = resolveExecutable({
    executable: 'opencode',
    platform: 'win32',
    env: { OPENCODE_BIN_PATH: 'C:\\tools\\opencode.exe', PATH: '' },
    existsSync: () => true
  });
  assert.equal(resolved, 'C:\\tools\\opencode.exe');
});

test('resolveExecutable finds the native exe next to the npm .cmd shim', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gate-opencode-'));
  try {
    const shimDir = path.join(root, 'npm');
    const exe = path.join(shimDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    mkdirSync(path.dirname(exe), { recursive: true });
    writeFileSync(exe, '');
    writeFileSync(
      path.join(shimDir, 'opencode.cmd'),
      '@ECHO off\nSET dp0=%~dp0\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*'
    );
    const resolved = resolveExecutable({
      executable: 'opencode',
      platform: 'win32',
      env: { PATH: shimDir },
      pathApi: path
    });
    assert.equal(resolved.toLowerCase(), exe.toLowerCase());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});