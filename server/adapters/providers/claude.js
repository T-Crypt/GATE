import { randomUUID } from 'node:crypto';

import { AppError } from '../../domain/errors.js';
import { ProcessRunner } from './process-runner.js';

const timelineSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['nodes', 'edges', 'gates'],
  properties: {
    nodes: { type: 'array', items: { type: 'object' } },
    edges: { type: 'array', items: { type: 'object' } },
    gates: { type: 'array', items: { type: 'object' } }
  }
};

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

export class ClaudeProvider {
  constructor({ executable = 'claude', runner = new ProcessRunner(), outputLimitBytes = 2_000_000 } = {}) {
    this.executable = executable;
    this.runner = runner;
    this.outputLimitBytes = outputLimitBytes;
  }

  capabilities() {
    return { streaming: true, resume: false, structuredDrafts: true };
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
          sessionId
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

  async draftTimeline({ goal, repositoryContext, cwd, env }) {
    const chunks = [];
    const prompt = [
      'Create a concise implementation timeline for the following local repository goal.',
      'Return milestones and executable steps. Add code, test, visual, or approval gates where evidence is required.',
      `Goal: ${goal}`,
      `Repository context: ${repositoryContext || 'No additional context supplied.'}`
    ].join('\n\n');
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
          ''
        ],
        cwd,
        input: prompt,
        env: env || process.env,
        outputLimitBytes: this.outputLimitBytes
      },
      { onOutput: (chunk) => chunks.push(chunk) }
    );
    const result = await running.completion;
    if (result.exitCode !== 0) {
      throw new AppError('PROVIDER_FAILED', 'Claude timeline drafting failed', { status: 502 });
    }
    return parseStructuredOutput(chunks.join(''));
  }
}
