import fsSync from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../../domain/errors.js';
import { ProcessRunner } from './process-runner.js';
import { createLineReader, failureMessage, parseTimelineJson, probeAuth, suggestedModels } from './cli-support.js';
import { buildTimelinePrompt } from './timeline-contract.js';

// The CLI's own default, which is reason enough to use it. Vendor docs disagree
// with themselves about whether `auto` routes by task complexity or just
// resolves to Pro, so Gate does not claim either.
export const DEFAULT_MODEL = 'auto';

// Suggestions, not a catalog — see `listModels`. These are the CLI's documented
// model aliases plus the two concrete 2.5 ids; the Gemini 3 ids are still
// `-preview`-suffixed and turn over, so the aliases are the stable way to ask
// for them and `complete: false` lets a user type an id Gate has never heard of.
const SUGGESTED = [
  { id: 'auto', label: 'auto — the CLI default' },
  { id: 'pro', label: 'pro — most capable' },
  { id: 'flash', label: 'flash — balanced' },
  { id: 'flash-lite', label: 'flash-lite — fastest' },
  { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' }
];

// Gemini has no `auth status` subcommand, so being installed proves nothing
// about being signed in. Look at what a signed-in install actually leaves
// behind: an API key in the environment, or OAuth credentials on disk.
export function hasCredentials({ env = process.env, homeDir = os.homedir(), existsSync = fsSync.existsSync } = {}) {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return true;
  // The CLI resolves its own home through GEMINI_CLI_HOME before falling back to
  // the OS home, so reading only the latter reports a signed-in install as
  // signed out whenever that override is set.
  return existsSync(path.join(env.GEMINI_CLI_HOME || homeDir, '.gemini', 'oauth_creds.json'));
}

// `--output-format json` wraps the answer: { response, stats, error }.
function unwrapEnvelope(output) {
  let envelope;
  try {
    envelope = JSON.parse(output.trim());
  } catch {
    // Older builds ignore --output-format and print the answer bare. That is
    // still usable — the timeline parser tolerates a fenced or plain object.
    return output;
  }
  if (envelope?.error) {
    throw new AppError('PROVIDER_FAILED', envelope.error.message || 'Gemini reported an error', { status: 502 });
  }
  return typeof envelope?.response === 'string' ? envelope.response : output;
}

export class GeminiProvider {
  constructor({
    executable = 'gemini',
    runner = new ProcessRunner(),
    outputLimitBytes = 2_000_000,
    env = process.env
  } = {}) {
    this.executable = executable;
    this.runner = runner;
    this.outputLimitBytes = outputLimitBytes;
    this.env = env;
    this.defaultModel = DEFAULT_MODEL;
  }

  // Declared so the provider roster can tell a user what a backend gives up
  // before they commit a project to it. Only what a caller actually consults
  // belongs here: resumption and model discovery were dropped because Gate
  // resumes nothing (see AGENTS.md) and `listModels().complete` already says
  // whether a catalog can be enumerated.
  capabilities() {
    return { streaming: true, structuredDrafts: false };
  }

  async listModels() {
    const installed = await probeAuth(this.runner, { executable: this.executable, args: ['--version'] });
    return suggestedModels(installed.authenticated && hasCredentials({ env: this.env }), SUGGESTED);
  }

  async start(request, observer) {
    const sessionId = randomUUID();
    // `--output-format stream-json` emits NDJSON events carrying text in
    // `content`. The first one is the whole resolved prompt echoed back with
    // `role: 'user'`, so an unfiltered reader shows the operator Gate's own
    // multi-KB step prompt before any model output. Assistant text then arrives
    // as incremental chunks, which is why chunks are forwarded verbatim rather
    // than newline-terminated one at a time. stderr passes through untouched.
    const lineReader = createLineReader((event) => {
      if (event?.role && event.role !== 'assistant') return;
      const text = event?.content;
      if (typeof text !== 'string' || !text) return;
      observer?.onOutput?.(text, 'stdout');
    });
    const running = await this.runner.start(
      {
        executable: this.executable,
        args: [
          '--output-format',
          'stream-json',
          // The run already happens inside an isolated linked worktree, so
          // approving tools unattended is bounded by the worktree, not the repo.
          '--approval-mode',
          'yolo',
          '--model',
          request.model || this.defaultModel
        ],
        cwd: request.cwd,
        input: request.prompt,
        env: request.env || process.env,
        outputLimitBytes: request.outputLimitBytes || this.outputLimitBytes,
        signal: request.signal
      },
      {
        onOutput: (chunk, stream) =>
          stream === 'stdout' ? lineReader(chunk, 'stdout') : observer?.onOutput?.(chunk, stream),
        onOutputLimit: () => observer?.onOutputLimit?.()
      }
    );
    return { sessionId, completion: running.completion, cancel: running.cancel };
  }

  async draftTimeline({ goal, repositoryContext, cwd, model, env, feedback }) {
    const prompt = [
      buildTimelinePrompt({ goal, repositoryContext, feedback }),
      'Reply with that JSON object and nothing else. No prose, no markdown fences.'
    ].join('\n\n');
    const chunks = [];
    const running = await this.runner.start(
      {
        executable: this.executable,
        args: [
          '--output-format',
          'json',
          // Drafts stay read-only: the default approval mode grants no tool the
          // planner could use to touch the repository, and headless Gemini
          // declines rather than blocking on a prompt it cannot show.
          '--approval-mode',
          'default',
          '--model',
          model || this.defaultModel
        ],
        cwd,
        input: prompt,
        env: env || process.env,
        outputLimitBytes: this.outputLimitBytes
      },
      { onOutput: (chunk, stream) => (stream === 'stdout' ? chunks.push(chunk) : null) }
    );
    const result = await running.completion;
    const output = chunks.join('');
    if (result.exitCode !== 0) {
      throw new AppError('PROVIDER_FAILED', failureMessage('Gemini', output, result, 'response'), {
        status: 502,
        details: { exitCode: result.exitCode, signal: result.signal }
      });
    }
    return parseTimelineJson(unwrapEnvelope(output), 'Gemini');
  }
}
