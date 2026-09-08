import { Router } from 'express';
import db from '../db.js';
import { startAgentSession, killSession } from '../agent/bridge.js';

const router = Router();

// Kick off an agent session against a project's repo. promptStepId is optional -
// pass it when this run corresponds to a numbered step on a milestone so the
// step's status gets updated when the process exits.
router.post('/projects/:id/agent/run', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const { promptText, promptStepId } = req.body;
  if (!promptText) return res.status(400).json({ error: 'promptText required' });

  const sessionId = startAgentSession({
    projectId: project.id,
    promptStepId: promptStepId || null,
    promptText,
    cwd: project.repo_path,
    cmd: project.agent_cmd
  });

  if (promptStepId) {
    db.prepare(`UPDATE prompt_steps SET status = 'running' WHERE id = ?`).run(promptStepId);
  }

  res.json({ sessionId });
});

router.post('/agent/sessions/:id/kill', (req, res) => {
  const ok = killSession(Number(req.params.id));
  res.json({ killed: ok });
});

router.get('/projects/:id/agent/sessions', (req, res) => {
  res.json(
    db
      .prepare('SELECT id, status, prompt_text, started_at, finished_at FROM agent_sessions WHERE project_id = ? ORDER BY id DESC LIMIT 20')
      .all(req.params.id)
  );
});

router.get('/agent/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  res.json(session);
});

export default router;
