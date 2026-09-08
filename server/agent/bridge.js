import { spawn } from 'node:child_process';
import db from '../db.js';

// Tracks live processes by agent_session id so the WS layer can attach/detach
// and so a client reconnect (page refresh mid-run) can re-attach to the same process.
const liveSessions = new Map(); // sessionId -> { proc, subscribers: Set<ws> }

/**
 * Starts a CLI agent process for a project and streams stdout/stderr to subscribers.
 * cmd is read from projects.agent_cmd (default 'claude') so this isn't hardcoded to
 * one vendor CLI — point it at `claude`, a local codex/ollama wrapper script, etc.
 * The prompt is passed on stdin rather than argv, since CLI agents vary on how they
 * accept piped vs flagged input — adjust the spawn args below to match your CLI's contract.
 */
export function startAgentSession({ projectId, promptStepId, promptText, cwd, cmd }) {
  const insert = db.prepare(
    `INSERT INTO agent_sessions (project_id, prompt_step_id, prompt_text, status)
     VALUES (?, ?, ?, 'running')`
  );
  const { lastInsertRowid: sessionId } = insert.run(projectId, promptStepId ?? null, promptText);

  const proc = spawn(cmd || 'claude', [], {
    cwd,
    shell: true,
    env: process.env
  });

  const subscribers = new Set();
  liveSessions.set(sessionId, { proc, subscribers });

  proc.stdin.write(promptText + '\n');
  proc.stdin.end();

  const appendOutput = db.prepare(
    `UPDATE agent_sessions SET output = output || ? WHERE id = ?`
  );

  const broadcast = (chunk) => {
    appendOutput.run(chunk, sessionId);
    for (const ws of subscribers) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'agent_output', sessionId, chunk }));
      }
    }
  };

  proc.stdout.on('data', (data) => broadcast(data.toString()));
  proc.stderr.on('data', (data) => broadcast(data.toString()));

  proc.on('close', (code) => {
    const status = code === 0 ? 'done' : 'failed';
    db.prepare(
      `UPDATE agent_sessions SET status = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(status, sessionId);

    if (promptStepId) {
      db.prepare(
        `UPDATE prompt_steps SET status = ?, last_run_at = datetime('now') WHERE id = ?`
      ).run(status === 'done' ? 'done' : 'failed', promptStepId);
    }

    for (const ws of subscribers) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'agent_closed', sessionId, status }));
      }
    }
    liveSessions.delete(sessionId);
  });

  return sessionId;
}

export function attachSubscriber(sessionId, ws) {
  const session = liveSessions.get(sessionId);
  if (session) session.subscribers.add(ws);
}

export function detachSubscriber(sessionId, ws) {
  const session = liveSessions.get(sessionId);
  if (session) session.subscribers.delete(ws);
}

export function killSession(sessionId) {
  const session = liveSessions.get(sessionId);
  if (!session) return false;
  session.proc.kill('SIGTERM');
  db.prepare(`UPDATE agent_sessions SET status = 'killed', finished_at = datetime('now') WHERE id = ?`).run(sessionId);
  return true;
}
