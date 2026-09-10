import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../../domain/errors.js';
import { ProcessRunner } from './process-runner.js';
import { createLineReader, failureMessage, parseTimelineJson, probeAuth, suggestedModels } from './cli-support.js';
import { buildTimelinePrompt, timelineSchema } from './timeline-contract.js';

// `codex exec -` reads the whole prompt from stdin, which keeps Gate's multi-KB
// step prompts off the command line entirely.
const STDIN_PROMPT = '-';

// Codex is the only adapter besides Claude that can be handed a JSON Schema, so
// drafting uses `--output-schema` and reads the constrained answer back from
// `--output-last-message` instead of guessing at the event stream's shape.
function draftArgs({ schemaPath, messagePath, model }) {
  return [
    'exec',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    messagePath,
    // Drafting reasons over the goal and repository context text. A read-only
    // sandbox is the same guarantee the other adapters get by denying edits.
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    ...(model ? ['--model', model] : []),
    STDIN_PROMPT
  ];
}

// `--json` emits one event per line: thread.started, turn.started, item.started,
// item.completed, turn.completed, error. Item shapes vary by Codex version, so
// pull text from whichever field carries it and drop anything unrecognised —
// Codex also streams human-readable progress on stderr, which Gate forwards
// verbatim, so a shape this misses is never a silent run.
function eventText(event) {
  if (event.type === 'error') {
    const message = event.message || event.error?.message;
    return message ? `[codex error] ${message}\n` : null;
  }
  if (event.type !== 'item.completed') return null;
  const item = event.item || {};
  const kind = item.item_type || item.type;
  if (kind === 'command_execution') {
    return item.command ? `$ ${item.command}\n` : null;
  }
  if (kind === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.map((change) => change.path).filter(Boolean);
    return paths.length ? `edited ${paths.join(', ')}\n` : null;
  }
  if (kind !== 'agent_message' && kind !== 'reasoning') return null;
  const text = item.text ?? item.message ?? item.content;
  if (typeof text !== 'string' || !text.trim()) return null;
  return text.endsWith('\n') ? text : `${text}\n`;
}

export class CodexProvider {
  constructor({
    executable = 'codex',
    runner = new ProcessRunner(),
    outputLimitBytes = 2_000_000,
    tmpDir = os.tmpdir()
  } = {}) {
    this.executable = executable;
    this.runner = runner;
    this.outputLimitBytes = outputLimitBytes;
    this.tmpDir = tmpDir;
  }

  capabilities() {
    return { streaming: true, resume: false, structuredDrafts: true, modelDiscovery: false };
  }

  // Codex has no machine-readable model list and its ids turn over every few
  // weeks. Offering a stale pinned list would be worse than offering none, so
  // the catalog is marked incomplete: Gate suggests nothing it cannot verify and
  // accepts whatever id the user supplies. A blank model defers to the model in
  // the user's own ~/.codex/config.toml.
  async listModels() {
    const status = await probeAuth(this.runner, { executable: this.executable, args: ['login', 'status'] });
    return suggestedModels(status.authenticated, []);
  }

  async start(request, observer) {
    const sessionId = randomUUID();
    let threadId = null;
    const lineReader = createLineReader((event) => {
      threadId = event.thread_id || event.threadId || threadId;
      const text = eventText(event);
      if (text) observer?.onOutput?.(text, 'stdout');
    });
    const running = await this.runner.start(
      {
        executable: this.executable,
        args: [
          'exec',
          '--json',
          // The run already happens inside an isolated linked worktree; Codex
          // may write there and nowhere else.
          '--sandbox',
          'workspace-write',
          '--skip-git-repo-check',
          ...(request.model ? ['--model', request.model] : []),
          STDIN_PROMPT
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
    return { sessionId: threadId || sessionId, completion: running.completion, cancel: running.cancel };
  }

  async draftTimeline({ goal, repositoryContext, cwd, model, env, feedback }) {
    const scratch = await fs.mkdtemp(path.join(this.tmpDir, 'gate-codex-'));
    const schemaPath = path.join(scratch, 'timeline.schema.json');
    const messagePath = path.join(scratch, 'timeline.json');
    try {
      await fs.writeFile(schemaPath, JSON.stringify(timelineSchema), 'utf8');
      const chunks = [];
      const running = await this.runner.start(
        {
          executable: this.executable,
          args: draftArgs({ schemaPath, messagePath, model }),
          cwd,
          input: buildTimelinePrompt({ goal, repositoryContext, feedback }),
          env: env || process.env,
          outputLimitBytes: this.outputLimitBytes
        },
        { onOutput: (chunk) => chunks.push(chunk) }
      );
      const result = await running.completion;
      const output = chunks.join('');
      if (result.exitCode !== 0) {
        throw new AppError('PROVIDER_FAILED', failureMessage('Codex', output, result), {
          status: 502,
          details: { exitCode: result.exitCode, signal: result.signal }
        });
      }
      // The schema-constrained answer lands in the file, not on stdout, which is
      // still carrying progress lines.
      const message = await fs.readFile(messagePath, 'utf8').catch(() => '');
      return parseTimelineJson(message, 'Codex');
    } finally {
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}
