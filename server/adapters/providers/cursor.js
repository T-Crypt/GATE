import { randomUUID } from 'node:crypto';

import { AppError } from '../../domain/errors.js';
import { ProcessRunner } from './process-runner.js';
import { createLineReader, failureMessage, parseTimelineJson, runCollecting } from './cli-support.js';
import { buildTimelinePrompt } from './timeline-contract.js';

// `-p`/`--print` is a boolean: it puts the agent in non-interactive print mode.
// The prompt is the documented positional argument. Piped stdin is documented
// only as a trigger for inferring print mode, never as a source for the prompt,
// so Gate passes it positionally — a few KB is far under any argv limit.
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

  // Declared so the provider roster can tell a user what a backend gives up
  // before they commit a project to it. Only what a caller actually consults
  // belongs here: resumption and model discovery were dropped because Gate
  // resumes nothing (see site/docs/providers.md) and `listModels().complete` already says
  // whether a catalog can be enumerated.
  capabilities() {
    return { streaming: true, structuredDrafts: false };
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
        // Each tool call is keyed by its own field — `readToolCall`,
        // `writeToolCall`, and so on — with a flat name only under `function`
        // for anything unrecognised. Reading `tool_call.name` matched nothing,
        // so the two most common tools reported no activity at all.
        const name = event.tool_call?.function?.name || Object.keys(event.tool_call ?? {})[0];
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
          ...(request.model ? ['--model', request.model] : []),
          request.prompt
        ],
        cwd: request.cwd,
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
        // No `--force` here, so a command the planner proposes is never
        // approved. Print mode still reaches read and write tools, which is why
        // Cursor drafting is the one path Gate cannot sandbox — see
        // site/docs/providers.md.
        ...(model ? ['--model', model] : []),
        prompt
      ],
      cwd,
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
