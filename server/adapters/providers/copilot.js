import { randomUUID } from 'node:crypto';

import { AppError } from '../../domain/errors.js';
import { ProcessRunner } from './process-runner.js';
import { failureMessage, parseTimelineJson, probeAuth, runCollecting, suggestedModels } from './cli-support.js';
import { buildTimelinePrompt } from './timeline-contract.js';

// Copilot CLI takes the prompt as the value of `-p`; it has no stdin mode. Gate's
// step prompts are a few KB, which is fine everywhere except Windows, where the
// command line caps at ~32 KB — noted in the provider docs.
const PROMPT_FLAG = '-p';

// Documented precedence, highest first.
const TOKEN_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

export function hasCredentials(env = process.env) {
  return TOKEN_VARS.some((name) => Boolean(env[name]));
}

export class CopilotProvider {
  constructor({
    executable = 'copilot',
    runner = new ProcessRunner(),
    outputLimitBytes = 2_000_000,
    env = process.env
  } = {}) {
    this.executable = executable;
    this.runner = runner;
    this.outputLimitBytes = outputLimitBytes;
    this.env = env;
  }

  // Copilot CLI has no structured output mode at all: it writes prose. Drafting
  // works because the shared timeline contract ships as prose too, but there is
  // no schema enforcing it, so mark the capability honestly.
  capabilities() {
    return { streaming: true, resume: false, structuredDrafts: false, modelDiscovery: false };
  }

  // Model strings are only discoverable from `copilot help` prose, which is not
  // a contract worth parsing. The catalog is marked incomplete so any id the
  // user knows about is accepted; blank defers to the CLI's own default.
  async listModels() {
    const installed = await probeAuth(this.runner, { executable: this.executable, args: ['--version'] });
    return suggestedModels(installed.authenticated && hasCredentials(this.env), []);
  }

  async start(request, observer) {
    const sessionId = randomUUID();
    const running = await this.runner.start(
      {
        executable: this.executable,
        args: [
          PROMPT_FLAG,
          request.prompt,
          // The run already happens inside an isolated linked worktree, so full
          // tool access is bounded by the worktree, not the repository.
          '--allow-all-tools',
          '--no-ask-user',
          ...(request.model ? ['--model', request.model] : [])
        ],
        cwd: request.cwd,
        env: request.env || process.env,
        outputLimitBytes: request.outputLimitBytes || this.outputLimitBytes,
        signal: request.signal
      },
      // Plain text on both streams — pass it through as the run log.
      observer
    );
    return { sessionId, completion: running.completion, cancel: running.cancel };
  }

  async draftTimeline({ goal, repositoryContext, cwd, model, env, feedback }) {
    const prompt = [
      buildTimelinePrompt({ goal, repositoryContext, feedback }),
      'Reply with that JSON object and nothing else. No prose, no markdown fences.'
    ].join('\n\n');
    const { output, result } = await runCollecting(this.runner, {
      executable: this.executable,
      args: [
        PROMPT_FLAG,
        prompt,
        // No `--allow-all-tools`: drafting gets no shell and no writes. `-s`
        // drops the stats banner so stdout is the answer alone, and
        // `--no-ask-user` stops the CLI blocking on a question it cannot ask.
        '-s',
        '--no-ask-user',
        ...(model ? ['--model', model] : [])
      ],
      cwd,
      env: env || process.env,
      outputLimitBytes: this.outputLimitBytes
    });
    if (result.exitCode !== 0) {
      throw new AppError('PROVIDER_FAILED', failureMessage('Copilot', output, result), {
        status: 502,
        details: { exitCode: result.exitCode, signal: result.signal }
      });
    }
    return parseTimelineJson(output, 'Copilot');
  }
}
