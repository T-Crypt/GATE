import { GitAdapter } from './adapters/git.js';
import { GithubRemoteAdapter } from './adapters/remote/github.js';
import { ClaudeProvider } from './adapters/providers/claude.js';
import { CodexProvider } from './adapters/providers/codex.js';
import { CopilotProvider } from './adapters/providers/copilot.js';
import { CursorProvider } from './adapters/providers/cursor.js';
import { GeminiProvider } from './adapters/providers/gemini.js';
import { OpenCodeProvider } from './adapters/providers/opencode.js';
import { DashboardService } from './application/dashboard-service.js';
import { ContextCompiler } from './application/context-compiler.js';
import { EventStore } from './application/event-store.js';
import { ExecutionService } from './application/execution-service.js';
import { FeatureService } from './application/feature-service.js';
import { InboxService } from './application/inbox-service.js';
import { InstructionService } from './application/instruction-service.js';
import { MemoryService } from './application/memory-service.js';
import { ProjectService } from './application/project-service.js';
import { PlannerService } from './application/planner-service.js';
import { RemoteService } from './application/remote-service.js';
import { RepoMirrorService } from './application/repo-mirror.js';
import { ReviewService } from './application/review-service.js';
import { TimelineService } from './application/timeline-service.js';

export function buildServices({ db, config, providers }) {
  const events = new EventStore(db);
  const gitAdapter = new GitAdapter();
  const projects = new ProjectService(db, events, gitAdapter);
  const timeline = new TimelineService(db, events);
  // One entry per shipped adapter. A project's `providerKind` is the key; the
  // adapters are constructed eagerly because nothing here touches a CLI until a
  // run starts or a model catalog is requested.
  const providerMap =
    providers ||
    new Map(
      [
        ['claude', ClaudeProvider],
        ['opencode', OpenCodeProvider],
        ['codex', CodexProvider],
        ['gemini', GeminiProvider],
        ['cursor', CursorProvider],
        ['copilot', CopilotProvider]
      ].map(([kind, Provider]) => [kind, new Provider({ outputLimitBytes: config.outputLimitBytes })])
    );
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
  const memory = new MemoryService({ db, projects, gitAdapter, eventStore: events });
  const contexts = new ContextCompiler({ db, projects, memory, instructions, gitAdapter, eventStore: events });
  const features = new FeatureService(db, events, projects);
  const planner = new PlannerService({ db, events, projects, features, memory, contexts, execution, timeline, gitAdapter });
  execution.attachPlanner(planner);
  const inbox = new InboxService({ db, events, projects, planner });
  return {
    db,
    events,
    projects,
    instructions,
    memory,
    contexts,
    features,
    planner,
    inbox,
    timeline,
    execution,
    reviews: new ReviewService(db, events),
    dashboard: new DashboardService(db, events, projects, gitAdapter),
    remote: new RemoteService(db, events, projects, gitAdapter, remoteAdapter, config),
    repoMirror,
    providers: providerMap
  };
}
