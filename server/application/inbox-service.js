import { runIdempotent } from './idempotency.js';
import { validation } from '../domain/errors.js';

// Reading the whole history would make the inbox slower the longer a project
// lives, for items nobody acts on any more. Newest first, bounded per source.
const PER_SOURCE_LIMIT = 50;
// Every accepted plan costs a git comparison to classify, so the staleness
// sweep is bounded separately and reports what it did not reach.
const STALENESS_CHECK_LIMIT = 25;
const ITEM_KEY = /^[a-z_]+:[A-Za-z0-9._-]{1,200}$/;

function summarize(text, max = 140) {
  const single = String(text ?? '').replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

// A source label the human recognises without opening the item.
function sourceLabel(sourceType) {
  return { feature: 'Feature', issue: 'Issue', milestone: 'Milestone' }[sourceType] || sourceType;
}

export class InboxService {
  constructor({ db, events, projects, planner }) {
    Object.assign(this, { db, events, projects, planner });
  }

  #dismissed(projectId) {
    return new Set(
      this.db.prepare('SELECT item_key FROM inbox_dismissals WHERE project_id = ?').all(projectId).map((row) => row.item_key)
    );
  }

  // A stale plan that already has a re-grounded proposal waiting is not
  // undecided — the decision moved to that proposal, which has its own item.
  #supersededBy(projectId) {
    return new Set(
      this.db.prepare("SELECT supersedes_id FROM planning_requests WHERE project_id = ? AND status = 'proposed' AND supersedes_id IS NOT NULL")
        .all(projectId).map((row) => row.supersedes_id)
    );
  }

  #proposedItems(projectId, dismissed) {
    const rows = this.db.prepare(
      `SELECT id, source_type, source_id, goal, created_at, supersedes_id FROM planning_requests
       WHERE project_id = ? AND status = 'proposed' ORDER BY created_at DESC, rowid DESC LIMIT ?`
    ).all(projectId, PER_SOURCE_LIMIT);
    return rows.map((row) => ({
      key: `plan_proposed:${row.id}`,
      kind: 'plan_proposed',
      title: row.supersedes_id
        ? `Re-grounded ${sourceLabel(row.source_type).toLowerCase()} plan awaiting acceptance`
        : `Proposed ${sourceLabel(row.source_type).toLowerCase()} plan awaiting acceptance`,
      detail: summarize(row.goal),
      subject: row.goal,
      createdAt: row.created_at,
      source: { type: row.source_type, id: row.source_id },
      route: row.source_type === 'feature' ? 'features' : row.source_type === 'issue' ? 'issues' : 'timeline',
      planningRequestId: row.id,
      supersedesId: row.supersedes_id,
      // Acceptance is a human decision made where the plan and its impact are
      // visible, so the inbox links there instead of accepting from a list row.
      actions: ['analyze', 'dismiss']
    })).filter((item) => !dismissed.has(item.key));
  }

  async #staleItems(projectId, dismissed) {
    const rows = this.db.prepare(
      `SELECT id, source_type, source_id, goal, accepted_at FROM planning_requests
       WHERE project_id = ? AND status = 'accepted' ORDER BY accepted_at DESC, rowid DESC LIMIT ?`
    ).all(projectId, STALENESS_CHECK_LIMIT);
    const superseded = this.#supersededBy(projectId);
    const items = [];
    for (const row of rows) {
      const key = `plan_stale:${row.id}`;
      if (dismissed.has(key) || superseded.has(row.id)) continue;
      let staleness;
      try {
        staleness = await this.planner.checkStaleness(projectId, row.id);
      } catch {
        // Staleness is advisory. A repository that cannot answer the question
        // must not empty the inbox of everything else.
        continue;
      }
      if (staleness.status !== 'STALE') continue;
      items.push({
        key,
        kind: 'plan_stale',
        title: `Accepted ${sourceLabel(row.source_type).toLowerCase()} plan has drifted`,
        detail: summarize(staleness.reason),
        subject: row.goal,
        createdAt: row.accepted_at,
        source: { type: row.source_type, id: row.source_id },
        route: row.source_type === 'feature' ? 'features' : row.source_type === 'issue' ? 'issues' : 'timeline',
        planningRequestId: row.id,
        staleness,
        convert: { title: summarize(`Re-ground plan: ${row.goal}`, 200), branch: null, kind: 'task' },
        actions: ['analyze', 'reground', 'convert', 'dismiss']
      });
    }
    return { items, truncated: rows.length === STALENESS_CHECK_LIMIT };
  }

  // A failed run with an issue already tracking its branch has been triaged;
  // that link is what "no follow-up" is derived from, so no inbox state is
  // needed to remember it.
  #failedRunItems(projectId, dismissed) {
    const rows = this.db.prepare(
      `SELECT runs.id, runs.branch, runs.node_id, runs.started_at, runs.finished_at,
              timeline_nodes.display_key AS node_key, timeline_nodes.title AS node_title
       FROM runs
       LEFT JOIN timeline_nodes ON timeline_nodes.id = runs.node_id
       WHERE runs.project_id = ? AND runs.status = 'failed'
         AND NOT EXISTS (SELECT 1 FROM issues WHERE issues.project_id = runs.project_id AND issues.branch = runs.branch)
       ORDER BY runs.finished_at DESC, runs.started_at DESC LIMIT ?`
    ).all(projectId, PER_SOURCE_LIMIT);
    return rows.map((row) => {
      const label = [row.node_key, row.node_title].filter(Boolean).join(' · ') || row.id.slice(0, 8);
      return {
        key: `run_failed:${row.id}`,
        kind: 'run_failed',
        title: `Run failed with no follow-up: ${label}`,
        detail: `Branch ${row.branch}`,
        subject: row.node_title || label,
        createdAt: row.finished_at || row.started_at,
        source: { type: 'run', id: row.id },
        route: 'activity',
        runId: row.id,
        nodeId: row.node_id,
        convert: { title: summarize(`Failed run: ${label}`, 200), branch: row.branch, kind: 'bug' },
        actions: ['analyze', 'convert', 'dismiss']
      };
    }).filter((item) => !dismissed.has(item.key));
  }

  async list(projectId) {
    this.projects.get(projectId);
    const dismissed = this.#dismissed(projectId);
    const stale = await this.#staleItems(projectId, dismissed);
    const items = [...stale.items, ...this.#proposedItems(projectId, dismissed), ...this.#failedRunItems(projectId, dismissed)]
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    return {
      projectId,
      items,
      counts: items.reduce((totals, item) => ({ ...totals, [item.kind]: (totals[item.kind] || 0) + 1 }), {}),
      // Say what was not examined rather than letting a bounded sweep read as
      // "nothing else has drifted".
      stalenessTruncated: stale.truncated,
      stalenessCheckLimit: STALENESS_CHECK_LIMIT
    };
  }

  dismiss(projectId, itemKey, context) {
    this.projects.get(projectId);
    const key = String(itemKey ?? '').trim();
    if (!ITEM_KEY.test(key)) throw validation('A valid inbox item key is required', { field: 'itemKey' });
    return runIdempotent(this.db, context, { command: 'inbox.dismiss', projectId, itemKey: key }, () => {
      this.events.append({
        projectId,
        type: 'inbox.dismissed',
        actor: context.actor,
        correlationId: context.correlationId,
        payload: { itemKey: key }
      }, () => {
        this.db.prepare(
          `INSERT INTO inbox_dismissals(project_id, item_key, actor_type, actor_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, item_key) DO NOTHING`
        ).run(projectId, key, context.actor.type, String(context.actor.id));
      });
      const row = this.db.prepare('SELECT * FROM inbox_dismissals WHERE project_id = ? AND item_key = ?').get(projectId, key);
      return { projectId, itemKey: key, dismissedAt: row.dismissed_at, actor: { type: row.actor_type, id: row.actor_id } };
    });
  }
}
