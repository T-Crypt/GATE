import { randomUUID } from 'node:crypto';

import { AppError } from '../../domain/errors.js';
import { ProcessRunner } from './process-runner.js';
import { failureMessage, isEmptyObject, probeAuth, runCollecting } from './cli-support.js';
import { buildTimelinePrompt, timelineSchema } from './timeline-contract.js';

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
    const status = await probeAuth(this.runner, { executable: this.executable, args: ['auth', 'status'] });
    return {
      authenticated: status.authenticated,
      models: [
        { id: 'opus', label: 'Opus — most capable' },
        { id: 'sonnet', label: 'Sonnet — balanced' },
        { id: 'haiku', label: 'Haiku — fastest' }
      ]
    };
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

  async draftTimeline({ goal, repositoryContext, cwd, model, env, feedback }) {
    const prompt = buildTimelinePrompt({ goal, repositoryContext, feedback });
    const { output, result } = await runCollecting(
      this.runner,
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
      { streams: 'all' }
    );
    if (result.exitCode !== 0) {
      // The CLI explains itself — an unreachable model, an expired login, a bad
      // flag. Throwing that away leaves a 502 that cannot be acted on.
      throw new AppError('PROVIDER_FAILED', failureMessage('Claude', output, result), {
        status: 502,
        details: { exitCode: result.exitCode, signal: result.signal }
      });
    }
    return parseStructuredOutput(output);
  }
}
