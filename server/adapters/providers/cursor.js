import { randomUUID } from 'node:crypto';

import { AppError } from '../../domain/errors.js';
import { ProcessRunner } from './process-runner.js';
import { createLineReader, failureMessage, parseTimelineJson, runCollecting } from './cli-support.js';
import { buildTimelinePrompt } from './timeline-contract.js';

// `-p`/`--print` is a boolean: it puts the agent in non-interactive print mode.
// The prompt itself is a positional argument or stdin, and Gate uses stdin so a
// multi-KB step prompt never hits a command-line length limit.
const PRINT_MODE = '--print';

// Assistant events carry the answer in `message.content`, which is either a
// string or the usual array of typed parts.
function assistantText(event) {
  const content = event?.message?.content ?? event?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text))
    .filter((part) => typeof part === 'string')
    .join('');
}

export class CursorProvider {
  constructor({ executable = 'cursor-agent', runner = new ProcessRunner(), outputLimitBytes = 2_000_000 } = {}) {
    this.executable = executable;
    this.runner = runner;
    this.outputLimitBytes = outputLimitBytes;
  }

  capabilities() {
    return { streaming: true, resume: false, structuredDrafts: false, modelDiscovery: true };
  }

  // `cursor-agent models` prints the ids this subscription can actually reach,
  // one per line. Read them rather than hardcoding a list that drifts.
  async listModels() {
    let output;
    let result;
    try {
      ({ output, result } = await runCollecting(this.runner, {
        executable: this.executable,
        args: ['models'],
        env: process.env,
        outputLimitBytes: 256_000
      }));
    } catch {
      return { authenticated: false, models: [] };
    }
    if (result.exitCode !== 0) return { authenticated: false, models: [] };
    const models = output
      .split('\n')
      .map((line) => line.trim())
      // Cursor marks the active model with a bullet or asterisk; strip it.
      .map((line) => line.replace(/^[-*•]\s*/, ''))
      .filter((line) => line && !line.includes(' '))
      .map((id) => ({ id, label: id }));
    return { authenticated: models.length > 0, models };
  }

  async start(request, observer) {
    const sessionId = randomUUID();
    let reportedSession = null;
    const lineReader = createLineReader((event) => {
      reportedSession = event.session_id || event.sessionId || reportedSession;
      if (event.type === 'tool_call' && event.subtype === 'started') {
        const name = event.tool_call?.name || event.name;
        if (name) observer?.onOutput?.(`· ${name}\n`, 'stdout');
        return;
      }
      if (event.type !== 'assistant') return;
      const text = assistantText(event);
      if (text) observer?.onOutput?.(text.endsWith('\n') ? text : `${text}\n`, 'stdout');
    });
    const running = await this.runner.start(
      {
        executable: this.executable,
        args: [
          PRINT_MODE,
          '--output-format',
          'stream-json',
          // The run already happens inside an isolated linked worktree, so
          // skipping command approval is bounded by the worktree, not the repo.
          '--force',
          ...(request.model ? ['--model', request.model] : [])
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
    return { sessionId: reportedSession || sessionId, completion: running.completion, cancel: running.cancel };
  }

  async draftTimeline({ goal, repositoryContext, cwd, model, env, feedback }) {
    const prompt = [
      buildTimelinePrompt({ goal, repositoryContext, feedback }),
      'Reply with that JSON object and nothing else. No prose, no markdown fences.'
    ].join('\n\n');
    const { output, result } = await runCollecting(this.runner, {
      executable: this.executable,
      args: [
        PRINT_MODE,
        '--output-format',
        'json',
        // No `--force` here: drafting must not be able to approve a command.
        ...(model ? ['--model', model] : [])
      ],
      cwd,
      input: prompt,
      env: env || process.env,
      outputLimitBytes: this.outputLimitBytes
    });
    if (result.exitCode !== 0) {
      throw new AppError('PROVIDER_FAILED', failureMessage('Cursor', output, result), {
        status: 502,
        details: { exitCode: result.exitCode, signal: result.signal }
      });
    }
    return parseTimelineJson(this.#answer(output), 'Cursor');
  }

  // `--output-format json` emits one result envelope with the aggregated text in
  // `result`. A build that ignores the flag prints the answer bare; both parse.
  #answer(output) {
    let envelope;
    try {
      envelope = JSON.parse(output.trim());
    } catch {
      return output;
    }
    if (envelope?.is_error) {
      throw new AppError('PROVIDER_FAILED', String(envelope.result || 'Cursor reported an error'), { status: 502 });
    }
    return typeof envelope?.result === 'string' ? envelope.result : output;
  }
}
