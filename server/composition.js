import { GitAdapter } from './adapters/git.js';
import { GithubRemoteAdapter } from './adapters/remote/github.js';
import { ClaudeProvider } from './adapters/providers/claude.js';
import { OpenCodeProvider } from './adapters/providers/opencode.js';
import { DashboardService } from './application/dashboard-service.js';
import { EventStore } from './application/event-store.js';
import { ExecutionService } from './application/execution-service.js';
import { InstructionService } from './application/instruction-service.js';
import { ProjectService } from './application/project-service.js';
import { RemoteService } from './application/remote-service.js';
import { RepoMirrorService } from './application/repo-mirror.js';
import { ReviewService } from './application/review-service.js';
import { TimelineService } from './application/timeline-service.js';

export function buildServices({ db, config, providers }) {
  const events = new EventStore(db);
  const gitAdapter = new GitAdapter();
  const projects = new ProjectService(db, events, gitAdapter);
  const timeline = new TimelineService(db, events);
  const providerMap =
    providers ||
    new Map([
      [
        'claude',
        new ClaudeProvider({
          outputLimitBytes: config.outputLimitBytes
        })
      ],
      [
        'opencode',
        new OpenCodeProvider({
          outputLimitBytes: config.outputLimitBytes
        })
      ]
    ]);
  const repoMirror = new RepoMirrorService({ db, projects });
  repoMirror.attach(events);
  const remoteAdapter = new GithubRemoteAdapter({
    token: config.githubToken,
    apiUrl: config.githubApiUrl
  });
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

  const instructions = new InstructionService({ db, projects, eventStore: events });
  return {
    db,
    events,
    projects,
    instructions,
    timeline,
    execution,
    reviews: new ReviewService(db, events),
    dashboard: new DashboardService(db, events, projects, gitAdapter),
    remote: new RemoteService(db, events, projects, gitAdapter, remoteAdapter, config),
    repoMirror,
    providers: providerMap
  };
}
