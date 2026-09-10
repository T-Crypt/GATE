import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { AppError } from '../../domain/errors.js';
import { ProcessRunner } from './process-runner.js';
import { createLineReader, failureMessage, parseTimelineJson } from './cli-support.js';
import { buildTimelinePrompt } from './timeline-contract.js';

export const DEFAULT_MODEL = 'opencode/big-pickle';

// npm installs the Windows command as a .ps1/.cmd shim that execs the real
// binary out of node_modules/opencode-ai/bin/opencode.exe. ProcessRunner spawns
// with shell:false, which cannot launch a .cmd/.bat shim, so the provider must
// resolve the native executable. On other platforms the bare name resolves via PATH.
export function resolveExecutable({
  executable = 'opencode',
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  pathApi = path
} = {}) {
  if (platform !== 'win32') return executable;
  if (pathApi.extname(executable) || pathApi.isAbsolute(executable)) return executable;
  if (env.OPENCODE_BIN_PATH && existsSync(env.OPENCODE_BIN_PATH)) return env.OPENCODE_BIN_PATH;

  const directories = (env.PATH || '').split(';').filter(Boolean);
  for (const directory of directories) {
    const candidate = pathApi.join(directory, `${executable}.exe`);
    if (existsSync(candidate)) return candidate;
  }
  for (const directory of directories) {
    const shim = pathApi.join(directory, `${executable}.cmd`);
    if (!existsSync(shim)) continue;
    const resolved = resolveFromShim(shim, directory, { existsSync, readFileSync, pathApi });
    if (resolved) return resolved;
  }
  return executable;
}

function resolveFromShim(shim, directory, { existsSync, readFileSync, pathApi }) {
  let content;
  try {
    content = readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  const marker = '%dp0%\\';
  const start = content.indexOf(marker);
  if (start === -1) return null;
  const remainder = content.slice(start + marker.length).trim();
  const pathEnd = remainder.search(/["\s\r\n]/);
  const relative = (pathEnd === -1 ? remainder : remainder.slice(0, pathEnd)).trim();
  if (!relative || !relative.toLowerCase().endsWith('.exe')) return null;
  const candidate = pathApi.join(directory, ...relative.split('\\'));
  return existsSync(candidate) ? candidate : null;
}

// `opencode run --format json` writes one JSON object per line. Some builds echo
// the user prompt back as its own finalized text part before the answer, so
// callers skip parts that exactly match the prompt and, for drafts, keep only the
// final text part (the assistant's answer). A build that does not echo is
// unaffected by either guard.
export class OpenCodeProvider {
  constructor({
    executable,
    runner = new ProcessRunner(),
    outputLimitBytes = 2_000_000,
    env = process.env,
    platform
  } = {}) {
    this.executable = resolveExecutable({ executable, env, platform });
    this.runner = runner;
    this.outputLimitBytes = outputLimitBytes;
    this.defaultModel = DEFAULT_MODEL;
  }

  // Declared so the provider roster can tell a user what a backend gives up
  // before they commit a project to it. Only what a caller actually consults
  // belongs here: resumption and model discovery were dropped because Gate
  // resumes nothing (see AGENTS.md) and `listModels().complete` already says
  // whether a catalog can be enumerated.
  //
  // `opencode run` has no schema flag — `--format json` frames events, not the
  // model's answer — so drafting relies on the prose contract, the same as
  // Gemini, Cursor, and Copilot. Claude and Codex are the only two with a schema.
  capabilities() {
    return { streaming: true, structuredDrafts: false };
  }

  // `opencode models` prints the ids this install can actually reach, one per
  // line. Read them rather than hardcoding a list that drifts.
  async listModels() {
    const chunks = [];
    let result;
    try {
      const running = await this.runner.start(
        {
          executable: this.executable,
          args: ['models'],
          env: process.env,
          outputLimitBytes: 256_000
        },
        { onOutput: (chunk, stream) => (stream === 'stdout' ? chunks.push(chunk) : null) }
      );
      result = await running.completion;
    } catch {
      return { authenticated: false, models: [] };
    }
    if (result.exitCode !== 0) return { authenticated: false, models: [] };
    const models = chunks
      .join('')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.includes(' '))
      .map((id) => ({ id, label: id === DEFAULT_MODEL ? `${id} — default` : id }));
    return { authenticated: models.length > 0, models };
  }

  async start(request, observer) {
    const sessionId = randomUUID();
    const model = request.model || this.defaultModel;
    const args = ['run', '--format', 'json', '--title', `gate:${request.nodeKey || request.runId || sessionId}`];
    if (model) args.push('--model', model);
    // Execution runs may touch the worktree freely; drafts stay read-only.
    if (request.permissionMode && request.permissionMode !== 'deny') args.push('--auto');

    let lastSessionId = null;
    const lineReader = createLineReader((event) => {
      lastSessionId = event.sessionID || lastSessionId;
      if (event.type !== 'text') return;
      if (event.part?.text === undefined || event.part.text === request.prompt) return;
      const chunk = event.part.text.endsWith('\n') ? event.part.text : `${event.part.text}\n`;
      observer?.onOutput?.(chunk, 'stdout');
    });
    const running = await this.runner.start(
      {
        executable: this.executable,
        args,
        cwd: request.cwd,
        input: request.prompt,
        env: request.env || process.env,
        outputLimitBytes: request.outputLimitBytes || this.outputLimitBytes,
        signal: request.signal
      },
      {
        onOutput: (chunk, stream) => (stream === 'stdout' ? lineReader(chunk, 'stdout') : observer?.onOutput?.(chunk, stream)),
        onOutputLimit: () => observer?.onOutputLimit?.()
      }
    );
    return { sessionId: lastSessionId || sessionId, completion: running.completion, cancel: running.cancel };
  }

  async draftTimeline({ goal, repositoryContext, cwd, model, env, feedback }) {
    const prompt = [
      buildTimelinePrompt({ goal, repositoryContext, feedback }),
      'Reply with that JSON object and nothing else. No prose, no markdown fences.'
    ].join('\n\n');
    const parts = [];
    const lineReader = createLineReader((event) => {
      if (event.type === 'text' && event.part?.text !== undefined) parts.push(event.part.text);
    });
    const running = await this.runner.start(
      {
        executable: this.executable,
        args: ['run', '--format', 'json', '--model', model || this.defaultModel],
        cwd,
        input: prompt,
        env: { ...(env || process.env), OPENCODE_PERMISSION: JSON.stringify({ bash: 'deny', edit: 'deny' }) },
        outputLimitBytes: this.outputLimitBytes
      },
      {
        onOutput: (chunk, stream) => {
          if (stream === 'stdout') lineReader(chunk, 'stdout');
        }
      }
    );
    const result = await running.completion;
    if (result.exitCode !== 0) {
      // Every other adapter surfaces the CLI's own reason; a bare exit code is
      // a 502 the user cannot act on.
      throw new AppError('PROVIDER_FAILED', failureMessage('OpenCode', parts.join(''), result), {
        status: 502,
        details: { exitCode: result.exitCode, signal: result.signal }
      });
    }
    // The last finalized text part is the assistant's answer; everything before
    // it is the echoed prompt, reasoning, or tool chatter.
    return parseTimelineJson(parts.at(-1), 'OpenCode');
  }
}
