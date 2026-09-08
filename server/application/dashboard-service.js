export class DashboardService {
  constructor(db) {
    this.db = db;
  }

  summary(projectId) {
    return {
      issues: this.db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY id DESC').all(projectId),
      notes: this.db.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY id DESC').all(projectId),
      gitEvents: this.db.prepare('SELECT * FROM git_events WHERE project_id = ? ORDER BY committed_at DESC LIMIT 100').all(projectId),
      activity: this.db.prepare('SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 100').all(projectId)
    };
  }
}
