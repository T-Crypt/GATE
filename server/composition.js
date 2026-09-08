import { GitAdapter } from './adapters/git.js';
import { ClaudeProvider } from './adapters/providers/claude.js';
import { DashboardService } from './application/dashboard-service.js';
import { EventStore } from './application/event-store.js';
import { ExecutionService } from './application/execution-service.js';
import { ProjectService } from './application/project-service.js';
import { RepoMirrorService } from './application/repo-mirror.js';
import { ReviewService } from './application/review-service.js';
import { TimelineService } from './application/timeline-service.js';

export function buildServices({ db, config, providers }) {
  const events = new EventStore(db);
  const projects = new ProjectService(db, events);
  const timeline = new TimelineService(db, events);
  const providerMap =
    providers ||
    new Map([
      [
        'claude',
        new ClaudeProvider({
          outputLimitBytes: config.outputLimitBytes
        })
      ]
    ]);
  const repoMirror = new RepoMirrorService({ db, projects });
  repoMirror.attach(events);
  const gitAdapter = new GitAdapter();
  const execution = new ExecutionService({
    db,
    eventStore: events,
    projectService: projects,
    timelineService: timeline,
    gitAdapter,
    providers: providerMap,
    worktreeDir: config.worktreeDir,
    outputLimitBytes: config.outputLimitBytes
  });

  return {
    db,
    events,
    projects,
    timeline,
    execution,
    reviews: new ReviewService(db, events),
    dashboard: new DashboardService(db, events, projects, gitAdapter),
    repoMirror,
    providers: providerMap
  };
}
