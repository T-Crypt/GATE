import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import db from '../db.js';

const execFileP = promisify(execFile);
const router = Router();

// --- Projects ---
router.get('/projects', (req, res) => {
  res.json(db.prepare('SELECT * FROM projects ORDER BY id DESC').all());
});

router.post('/projects', (req, res) => {
  const { name, repo_path, agent_cmd } = req.body;
  if (!name || !repo_path) return res.status(400).json({ error: 'name and repo_path required' });
  const { lastInsertRowid } = db
    .prepare('INSERT INTO projects (name, repo_path, agent_cmd) VALUES (?, ?, ?)')
    .run(name, repo_path, agent_cmd || 'claude');
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(lastInsertRowid));
});

// --- Git activity: pulls recent log from the project's repo_path and caches it ---
router.post('/projects/:id/git/sync', async (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });

  try {
    const { stdout: branch } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: project.repo_path
    });
    const { stdout: log } = await execFileP(
      'git',
      ['log', '-50', '--pretty=format:%H|||%an|||%s|||%cI'],
      { cwd: project.repo_path }
    );

    const insert = db.prepare(`
      INSERT OR IGNORE INTO git_events (project_id, commit_hash, author, message, branch, committed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const lines = log.split('\n').filter(Boolean);
    const tx = db.transaction((rows) => {
      for (const line of rows) {
        const [hash, author, message, committedAt] = line.split('|||');
        insert.run(project.id, hash, author, message, branch.trim(), committedAt);
      }
    });
    tx(lines);

    res.json({ synced: lines.length, branch: branch.trim() });
  } catch (err) {
    res.status(500).json({ error: 'git sync failed', detail: err.message });
  }
});

router.get('/projects/:id/git/events', (req, res) => {
  res.json(
    db
      .prepare('SELECT * FROM git_events WHERE project_id = ? ORDER BY committed_at DESC LIMIT 100')
      .all(req.params.id)
  );
});

// --- Issues ---
router.get('/projects/:id/issues', (req, res) => {
  res.json(db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY id DESC').all(req.params.id));
});

router.post('/projects/:id/issues', (req, res) => {
  const { title, branch } = req.body;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO issues (project_id, title, branch) VALUES (?, ?, ?)')
    .run(req.params.id, title, branch || null);
  res.json(db.prepare('SELECT * FROM issues WHERE id = ?').get(lastInsertRowid));
});

router.patch('/issues/:id', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE issues SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json(db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id));
});

// --- Notes + tags ---
router.get('/projects/:id/notes', (req, res) => {
  const notes = db.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY id DESC').all(req.params.id);
  const tagStmt = db.prepare(`
    SELECT t.* FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ?
  `);
  for (const note of notes) note.tags = tagStmt.all(note.id);
  res.json(notes);
});

router.post('/projects/:id/notes', (req, res) => {
  const { body, milestone_id, tags = [] } = req.body;
  const { lastInsertRowid: noteId } = db
    .prepare('INSERT INTO notes (project_id, milestone_id, body) VALUES (?, ?, ?)')
    .run(req.params.id, milestone_id || null, body);

  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const insertTag = db.prepare('INSERT INTO tags (name) VALUES (?)');
  const linkTag = db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)');

  for (const name of tags) {
    let tag = findTag.get(name);
    if (!tag) {
      const { lastInsertRowid } = insertTag.run(name);
      tag = { id: lastInsertRowid };
    }
    linkTag.run(noteId, tag.id);
  }

  res.json({ id: noteId });
});

router.get('/tags', (req, res) => {
  res.json(db.prepare('SELECT * FROM tags ORDER BY name').all());
});

export default router;
