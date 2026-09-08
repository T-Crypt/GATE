import { Router } from 'express';
import db from '../db.js';

const router = Router();

router.get('/projects/:id/milestones', (req, res) => {
  const milestones = db
    .prepare('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order ASC')
    .all(req.params.id);
  const stepStmt = db.prepare('SELECT * FROM prompt_steps WHERE milestone_id = ? ORDER BY step_order ASC');
  for (const m of milestones) m.steps = stepStmt.all(m.id);
  res.json(milestones);
});

router.post('/projects/:id/milestones', (req, res) => {
  const { title, color, goal_note } = req.body;
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM milestones WHERE project_id = ?')
    .get(req.params.id).m;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO milestones (project_id, title, color, sort_order, goal_note) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.id, title, color || '#4f8cff', maxOrder + 1, goal_note || null);
  res.json(db.prepare('SELECT * FROM milestones WHERE id = ?').get(lastInsertRowid));
});

// Locking freezes a milestone from AI-driven redraw; still manually editable.
router.patch('/milestones/:id', (req, res) => {
  const fields = ['title', 'color', 'status', 'goal_note', 'sort_order'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE milestones SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id));
});

router.delete('/milestones/:id', (req, res) => {
  db.prepare('DELETE FROM milestones WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

// Prompt steps within a milestone - the "#1, #2..." grid.
router.post('/milestones/:id/steps', (req, res) => {
  const { prompt_text } = req.body;
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(step_order), -1) AS m FROM prompt_steps WHERE milestone_id = ?')
    .get(req.params.id).m;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO prompt_steps (milestone_id, step_order, prompt_text) VALUES (?, ?, ?)')
    .run(req.params.id, maxOrder + 1, prompt_text);
  res.json(db.prepare('SELECT * FROM prompt_steps WHERE id = ?').get(lastInsertRowid));
});

router.patch('/steps/:id', (req, res) => {
  const { prompt_text, status, step_order } = req.body;
  const updates = [];
  const values = [];
  if (prompt_text !== undefined) { updates.push('prompt_text = ?'); values.push(prompt_text); }
  if (status !== undefined) { updates.push('status = ?'); values.push(status); }
  if (step_order !== undefined) { updates.push('step_order = ?'); values.push(step_order); }
  values.push(req.params.id);
  db.prepare(`UPDATE prompt_steps SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM prompt_steps WHERE id = ?').get(req.params.id));
});

export default router;
