// Shared plumbing for the CLI-backed provider adapters.
//
// Every provider Gate ships drives an agent CLI the same way: spawn it without
// a shell, hand it the prompt on stdin, and read a JSON or NDJSON answer back.
// The differences are the argv and the event shape — everything below is the
// part that was otherwise copied into each adapter.
//
// Nothing here knows about timelines, gates, or branches. Adapters translate
// CLI output into the shared timeline contract; the domain owns the rules.

import { AppError } from '../../domain/errors.js';

export function isEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

// Models that cannot be told "no prose" reliably still wrap the object in a
// fence. Unwrap one, and only one, so a fenced answer is not a hard failure.
export function stripCodeFence(output) {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(output.trim());
  return match ? match[1].trim() : output.trim();
}

// The one place a provider's raw answer becomes a candidate timeline graph.
// It is still untrusted after this: `normalizeTimelineGraph` is what decides
// whether Gate accepts it.
export function parseTimelineJson(text, label) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    throw new AppError('PROVIDER_OUTPUT_INCOMPLETE', `${label} produced no timeline text`, { status: 502 });
  }
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(trimmed));
  } catch {
    throw new AppError('PROVIDER_OUTPUT_INVALID', `${label} returned invalid JSON`, { status: 502 });
  }
  if (isEmptyObject(parsed)) {
    throw new AppError(
      'PROVIDER_OUTPUT_INCOMPLETE',
      `${label} finished without producing a timeline. Try rephrasing the goal or retry the draft.`,
      { status: 502 }
    );
  }
  return parsed;
}

// NDJSON arrives split across arbitrary chunk boundaries. Buffer until a
// newline, and treat a line that is not JSON as noise rather than an error —
// CLIs print progress banners on the same stream.
export function createLineReader(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line));
        } catch {
          // Non-JSON junk on stdout is not an event; ignore it line-by-line.
        }
      }
      newline = buffer.indexOf('\n');
    }
  };
}

// A non-zero exit still usually carries the CLI's own JSON envelope or a plain
// stderr line. Surface whichever is there instead of a generic failure — a bare
// "exit 1" is a 502 the user cannot act on.
export function failureMessage(label, output, result, resultKey = 'result') {
  const text = String(output || '').trim();
  if (text) {
    try {
      const envelope = JSON.parse(text);
      const detail = envelope?.[resultKey] ?? envelope?.error?.message ?? envelope?.message;
      if (detail) return String(detail);
    } catch {
      const line = text.split('\n').filter(Boolean).at(-1);
      if (line) return `${label} timeline drafting failed: ${line.slice(0, 500)}`;
    }
  }
  return `${label} timeline drafting failed (exit ${result?.exitCode ?? 'unknown'})`;
}

// Run a CLI to completion and hand back everything it wrote. `streams: 'stdout'`
// keeps stderr progress chatter out of a payload that has to parse as JSON.
export async function runCollecting(runner, spec, { streams = 'stdout' } = {}) {
  const chunks = [];
  const running = await runner.start(spec, {
    onOutput: (chunk, stream) => {
      if (streams === 'all' || stream === streams || stream === undefined) chunks.push(chunk);
    }
  });
  const result = await running.completion;
  return { output: chunks.join(''), result };
}

// A model catalog a CLI could not be asked for. `complete: false` tells Gate the
// list is a suggestion, so a model the user knows about is never rejected at
// save time just because the adapter could not enumerate it.
export function suggestedModels(authenticated, models) {
  return { authenticated, complete: false, models };
}

// Probe whether a CLI is installed and signed in by running a cheap subcommand.
// A missing executable is a configuration problem, not a fatal one: the caller
// still gets a catalog and a clear "not authenticated".
export async function probeAuth(runner, { executable, args, env = process.env }) {
  try {
    const { output, result } = await runCollecting(
      runner,
      { executable, args, env, outputLimitBytes: 64_000 },
      { streams: 'all' }
    );
    return { authenticated: result.exitCode === 0, detail: output.trim() };
  } catch {
    return { authenticated: false, detail: `${executable} is not available on PATH` };
  }
}
