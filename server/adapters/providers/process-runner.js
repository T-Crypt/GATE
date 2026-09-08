import { spawn } from 'node:child_process';

import { AppError } from '../../domain/errors.js';

export class ProcessRunner {
  async start(request, observer = {}) {
    const limit = Math.max(1, request.outputLimitBytes || 2_000_000);
    let outputBytes = 0;
    let truncated = false;
    let settled = false;
    let resolveCompletion;
    let rejectCompletion;

    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const child = spawn(request.executable, request.args || [], {
      cwd: request.cwd,
      env: request.env || process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const emit = (buffer, stream) => {
      if (truncated) return;
      const remaining = limit - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        observer.onOutputLimit?.();
        return;
      }
      const chunk = buffer.subarray(0, remaining).toString('utf8');
      outputBytes += Buffer.byteLength(chunk);
      observer.onOutput?.(chunk, stream);
      if (buffer.length > remaining) {
        truncated = true;
        observer.onOutputLimit?.();
      }
    };

    child.stdout.on('data', (chunk) => emit(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => emit(chunk, 'stderr'));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      rejectCompletion(
        new AppError('PROVIDER_LAUNCH_FAILED', `Unable to start ${request.executable}`, {
          status: 502,
          details: { message: error.message }
        })
      );
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolveCompletion({ exitCode, signal, truncated });
    });

    const cancel = async ({ graceMs = 3000 } = {}) => {
      if (settled) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, graceMs);
      timer.unref();
      await completion.catch(() => {});
      clearTimeout(timer);
    };

    if (request.signal) {
      if (request.signal.aborted) void cancel({ graceMs: 0 });
      else request.signal.addEventListener('abort', () => void cancel(), { once: true });
    }

    if (request.input !== undefined) child.stdin.end(String(request.input));
    else child.stdin.end();

    return { pid: child.pid, completion, cancel };
  }
}
