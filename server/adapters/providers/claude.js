import { randomUUID } from 'node:crypto';

import { AppError } from '../../domain/errors.js';
import { ProcessRunner } from './process-runner.js';
import { buildTimelinePrompt, timelineSchema } from './timeline-contract.js';

function isEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function parseStructuredOutput(output) {
  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch {
    throw new AppError('PROVIDER_OUTPUT_INVALID', 'Claude returned invalid JSON', { status: 502 });
  }
  if (envelope.is_error) {
    throw new AppError('PROVIDER_FAILED', envelope.result || 'Claude reported an error', { status: 502 });
  }
  const value = envelope.structured_output ?? envelope.result ?? envelope;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new AppError('PROVIDER_OUTPUT_INVALID', 'Claude result was not structured JSON', {
        status: 502
      });
    }
  }
  if (isEmptyObject(value)) {
    throw new AppError(
      'PROVIDER_OUTPUT_INCOMPLETE',
      'Claude finished without producing a timeline. Try rephrasing the goal or retry the draft.',
      { status: 502 }
    );
  }
  return value;
}

// A non-zero exit still usually carries the CLI's own JSON envelope or a plain
// stderr line. Surface whichever is there instead of a generic failure.
function providerFailureMessage(output, result) {
  const text = String(output || '').trim();
  if (text) {
    try {
      const envelope = JSON.parse(text);
      if (envelope.result) return String(envelope.result);
    } catch {
      const line = text.split('\n').filter(Boolean).at(-1);
      if (line) return `Claude timeline drafting failed: ${line.slice(0, 500)}`;
    }
  }
  return `Claude timeline drafting failed (exit ${result.exitCode ?? 'unknown'})`;
}

export class ClaudeProvider {
  constructor({ executable = 'claude', runner = new ProcessRunner(), outputLimitBytes = 2_000_000 } = {}) {
    this.executable = executable;
    this.runner = runner;
    this.outputLimitBytes = outputLimitBytes;
  }

  capabilities() {
    return { streaming: true, resume: false, structuredDrafts: true, modelDiscovery: true };
  }

  // The CLI has no machine-readable model list, but it does resolve these
  // aliases against whatever account `claude auth` is signed in as — an alias
  // the subscription cannot reach fails the same way a typo does. Offering the
  // aliases rather than pinned ids keeps Gate correct as models are released.
  async listModels() {
    const status = await this.#authStatus();
    return {
      authenticated: status.authenticated,
      models: [
        { id: 'opus', label: 'Opus — most capable' },
        { id: 'sonnet', label: 'Sonnet — balanced' },
        { id: 'haiku', label: 'Haiku — fastest' }
      ]
    };
  }

  async #authStatus() {
    const chunks = [];
    try {
      const running = await this.runner.start(
        {
          executable: this.executable,
          args: ['auth', 'status'],
          env: process.env,
          outputLimitBytes: 64_000
        },
        { onOutput: (chunk) => chunks.push(chunk) }
      );
      const result = await running.completion;
      return { authenticated: result.exitCode === 0, detail: chunks.join('').trim() };
    } catch {
      // A missing executable is a configuration problem, not a fatal one: the
      // caller still gets the alias list and a clear "not authenticated".
      return { authenticated: false, detail: `${this.executable} is not available on PATH` };
    }
  }

  async start(request, observer) {
    const sessionId = randomUUID();
    const running = await this.runner.start(
      {
        executable: this.executable,
        args: [
          '--print',
          '--verbose',
          '--output-format',
          'stream-json',
          '--permission-mode',
          request.permissionMode || 'acceptEdits',
          '--session-id',
          sessionId,
          ...(request.model ? ['--model', request.model] : [])
        ],
        cwd: request.cwd,
        input: request.prompt,
        env: request.env || process.env,
        outputLimitBytes: request.outputLimitBytes || this.outputLimitBytes,
        signal: request.signal
      },
      observer
    );
    return { sessionId, completion: running.completion, cancel: running.cancel };
  }

  async draftTimeline({ goal, repositoryContext, cwd, model, env }) {
    const chunks = [];
    const prompt = buildTimelinePrompt({ goal, repositoryContext });
    const running = await this.runner.start(
      {
        executable: this.executable,
        args: [
          '--print',
          '--output-format',
          'json',
          '--json-schema',
          JSON.stringify(timelineSchema),
          '--permission-mode',
          'acceptEdits',
          // Drafting reasons over the goal and repositoryContext text only; it never
          // needs filesystem or shell access. Disabling tools keeps the model from
          // wandering into open-ended exploration and guarantees it returns the
          // schema-constrained result directly instead of stopping mid tool-call
          // with an empty structured_output.
          '--tools',
          '',
          ...(model ? ['--model', model] : [])
        ],
        cwd,
        input: prompt,
        env: env || process.env,
        outputLimitBytes: this.outputLimitBytes
      },
      { onOutput: (chunk) => chunks.push(chunk) }
    );
    const result = await running.completion;
    const output = chunks.join('');
    if (result.exitCode !== 0) {
      // The CLI explains itself — an unreachable model, an expired login, a bad
      // flag. Throwing that away leaves a 502 that cannot be acted on.
      throw new AppError('PROVIDER_FAILED', providerFailureMessage(output, result), {
        status: 502,
        details: { exitCode: result.exitCode, signal: result.signal }
      });
    }
    return parseStructuredOutput(output);
  }
}
