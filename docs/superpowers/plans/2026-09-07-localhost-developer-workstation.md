# Project MCP Localhost Developer Workstation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready localhost workstation that plans AI-assisted work on an interactive dependency timeline, executes Claude in isolated worktrees, enforces hard branch and evidence gates, and exposes the same state through Web UI and MCP.

**Architecture:** A single Node process hosts the HTTP API, WebSocket event stream, scheduler, and static frontend; a second stdio entry point exposes MCP using the same application services. SQLite is the source of truth: commands validate intent, append immutable events, and update read projections transactionally. Git, Claude, WebSocket, and MCP are adapters around domain and application modules.

**Tech Stack:** Node.js 24+, built-in `node:sqlite`, Express, `ws`, MCP TypeScript SDK for JavaScript, Zod, Pino, Helmet, Node test runner, Supertest, and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-07-localhost-developer-workstation-design.md`

## Global Constraints

- Bind to `127.0.0.1` by default and emit a warning for non-loopback binding.
- Never merge, rebase onto, force-update, delete, push, or directly execute work on a protected branch.
- Always protect the selected base branch plus selected production and stable branches.
- Human review is mandatory before integration; Project MCP does not integrate branches.
- All writes from HTTP, WebSocket, MCP, providers, Git observers, and the scheduler pass through application commands.
- SQLite events are immutable and versioned; event and projection writes share one transaction.
- Claude is the first provider; timeline and scheduler modules depend only on a provider interface.
- Managed validation state lives under `data/tests/<project-id>/`; repository export is explicit.
- The UI must provide keyboard navigation, visible focus, reduced motion, responsive layouts, and complete loading, error, empty, reconnecting, and blocked states.
- New behavior follows strict red-green-refactor TDD.

## Target File Structure

```text
server/
  app.js                         Express composition without process startup
  index.js                       process lifecycle and WebSocket upgrade
  config.js                      environment parsing and safe defaults
  db/
    database.js                  node:sqlite connection and transactions
    migrate.js                   ordered migration runner
    migrations/001-foundation.sql
  domain/
    errors.js                    typed domain/application errors
    timeline.js                  DAG and transition policy
    branch-policy.js             hard protected-branch rules
    gates.js                     gate and evidence policy
  application/
    event-store.js               append and replay events
    project-service.js           project commands and projection reads
    timeline-service.js          timeline commands and projection reads
    execution-service.js         run lifecycle and scheduler orchestration
    review-service.js            evidence and review bundle reads
    dashboard-service.js         issues, notes, and Git activity reads
  adapters/
    git.js                       safe Git/worktree operations
    providers/claude.js          Claude executable adapter
    providers/process-runner.js  non-shell child process wrapper
    live-events.js               replayable WebSocket publication
  http/
    middleware.js                errors, request IDs, limits, idempotency
    projects.js
    timeline.js
    executions.js
    reviews.js
    dashboard.js
  mcp/server.js                  stdio MCP entry point
public/
  index.html
  css/style.css
  js/
    api.js                       HTTP client and normalized errors
    state.js                     application state and subscriptions
    app.js                       shell and routing
    components.js                safe shared HTML/component helpers
    timeline.js                  timeline canvas
    agent.js                     activity rail and execution controls
    dashboard.js                 overview, issues, and Git activity
    reviews.js                   gate evidence and approval review
    settings.js                  project and safety settings
tests/
  helpers/{database,git,fake-provider}.js
  unit/{timeline,branch-policy,gates}.test.js
  integration/{events,projects,execution,websocket,mcp}.test.js
  browser/workstation.spec.js
  fixtures/fake-claude.js
```

---

### Task 1: Runtime, Database, and Test Harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/config.js`
- Create: `server/db/database.js`
- Create: `server/db/migrate.js`
- Create: `server/db/migrations/001-foundation.sql`
- Modify: `server/db.js`
- Create: `tests/helpers/database.js`
- Create: `tests/integration/database.test.js`

**Interfaces:**
- Produces: `loadConfig(env) -> AppConfig`
- Produces: `openDatabase({ filename }) -> DatabaseSync`
- Produces: `withTransaction(db, fn) -> T`
- Produces: `migrate(db, migrationsDir) -> number`
- Produces: `createTestDatabase() -> { db, close }`

- [ ] **Step 1: Write the failing database tests**

```js
test('migrations create an immutable ordered event store', () => {
  const { db, close } = createTestDatabase();
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(
    db.prepare('PRAGMA journal_mode').get().journal_mode,
    'memory'
  );
  const columns = db.prepare('PRAGMA table_info(events)').all().map(row => row.name);
  assert.deepEqual(columns, [
    'id', 'project_id', 'sequence', 'type', 'schema_version', 'actor_type',
    'actor_id', 'correlation_id', 'causation_id', 'payload_json', 'created_at'
  ]);
  close();
});

test('withTransaction rolls back every write on failure', () => {
  const { db, close } = createTestDatabase();
  assert.throws(() => withTransaction(db, () => {
    db.prepare("INSERT INTO app_meta(key, value) VALUES ('sample', 'one')").run();
    throw new Error('stop');
  }), /stop/);
  assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'sample'").get(), undefined);
  close();
});
```

- [ ] **Step 2: Run the database test and verify RED**

Run: `node --test tests/integration/database.test.js`  
Expected: FAIL because the database modules and migration do not exist.

- [ ] **Step 3: Replace the native binding and implement migrations**

Use `DatabaseSync` from `node:sqlite`; set foreign keys, WAL for file databases, a 5-second busy timeout, and run numbered SQL files in a transaction. The first migration preserves the existing project, milestone, step, issue, note, tag, Git-event, and agent-session rows, adds required project policy fields through an idempotent table-copy migration, and creates `schema_migrations`, `app_meta`, `events`, `idempotency_keys`, `timeline_nodes`, `timeline_edges`, `gates`, `evidence`, `approvals`, `runs`, and `activity` with foreign keys and uniqueness on `(project_id, sequence)`. A fixture containing the legacy schema and sample rows must prove the migration retains user data.

```js
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

Set `engines.node` to `>=24`, remove `better-sqlite3`, add `test`, `test:unit`, `test:integration`, `test:browser`, `lint`, and `check` scripts, and add test/runtime dependencies.

- [ ] **Step 4: Run database tests and the full baseline**

Run: `npm test`  
Expected: PASS with database tests green and no native install-script warning.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json server/config.js server/db.js server/db tests
git commit -m "build: establish portable database and test foundation"
```

### Task 2: Immutable Events and Project Commands

**Files:**
- Create: `server/domain/errors.js`
- Create: `server/application/event-store.js`
- Create: `server/application/project-service.js`
- Create: `tests/integration/events.test.js`
- Create: `tests/integration/projects.test.js`

**Interfaces:**
- Produces: `EventStore.append({ projectId, type, actor, payload, correlationId, causationId }, project) -> StoredEvent`
- Produces: `EventStore.readAfter(projectId, sequence, limit) -> StoredEvent[]`
- Produces: `ProjectService.create(input, context) -> Project`
- Produces: `ProjectService.updatePolicy(projectId, input, context) -> Project`
- Produces: `ProjectService.list() -> Project[]`

- [ ] **Step 1: Write failing event and idempotency tests**

```js
test('append allocates monotonic per-project sequences', () => {
  const first = events.append(eventInput('project.created'), projectEvent);
  const second = events.append(eventInput('project.policy.updated'), projectEvent);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
});

test('repeating an idempotent create returns the original result', () => {
  const first = projects.create(validProject, context('same-key'));
  const second = projects.create(validProject, context('same-key'));
  assert.deepEqual(second, first);
  assert.equal(events.readAfter(first.id, 0, 20).length, 1);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/integration/events.test.js tests/integration/projects.test.js`  
Expected: FAIL because `EventStore` and `ProjectService` do not exist.

- [ ] **Step 3: Implement typed errors, events, and project policy projection**

Canonicalize repository paths with `realpathSync`, require an existing `.git` repository, normalize branches as unique non-empty names, and always union `baseBranch` into `protectedBranches`. Store JSON payloads only after validation. Use one transaction for sequence allocation, event insertion, projection update, and idempotency result storage.

- [ ] **Step 4: Verify GREEN and mutation cases**

Run: `node --test tests/integration/events.test.js tests/integration/projects.test.js`  
Expected: PASS, including duplicate keys, nonexistent repositories, empty branch names, and reused idempotency keys with different payloads.

- [ ] **Step 5: Commit**

```bash
git add server/domain/errors.js server/application/event-store.js server/application/project-service.js tests/integration/events.test.js tests/integration/projects.test.js
git commit -m "feat: add event-backed project commands"
```

### Task 3: Timeline DAG, Gates, and Evidence

**Files:**
- Create: `server/domain/timeline.js`
- Create: `server/domain/gates.js`
- Create: `server/application/timeline-service.js`
- Create: `tests/unit/timeline.test.js`
- Create: `tests/unit/gates.test.js`
- Create: `tests/integration/timeline.test.js`

**Interfaces:**
- Produces: `assertAcyclic(nodes, edges) -> void`
- Produces: `deriveReadiness(node, dependencies, gates) -> 'planned' | 'ready' | 'blocked'`
- Produces: `assertTransition(from, to) -> void`
- Produces: `evidenceIsFresh(evidence, headSha, changedFiles) -> boolean`
- Produces: `TimelineService.replaceDraft(projectId, graph, context) -> Timeline`
- Produces: `TimelineService.transition(projectId, nodeId, to, context) -> TimelineNode`

- [ ] **Step 1: Write failing domain tests**

```js
test('a dependency cycle is rejected with its path', () => {
  assert.throws(
    () => assertAcyclic([{ id: 'a' }, { id: 'b' }], [edge('a', 'b'), edge('b', 'a')]),
    error => error.code === 'TIMELINE_CYCLE' && error.details.path.join(' -> ') === 'a -> b -> a'
  );
});

test('a blocking visual gate keeps downstream work blocked', () => {
  assert.equal(deriveReadiness(node(), [completeDependency()], [gate('visual', 'pending')]), 'blocked');
});

test('evidence from another HEAD cannot satisfy a gate', () => {
  assert.equal(evidenceIsFresh(evidence({ headSha: 'old' }), 'new', []), false);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/unit/timeline.test.js tests/unit/gates.test.js`  
Expected: FAIL because timeline and gate policies do not exist.

- [ ] **Step 3: Implement policy and event-backed timeline commands**

Implement deterministic DFS cycle detection, an explicit transition matrix, typed edges (`depends_on`, `code_gate`, `test_gate`, `build_gate`, `plan_gate`, `visual_gate`, `approval_gate`), blocking gate evaluation, and file-scope evidence invalidation. `replaceDraft` preserves locked or active nodes and rejects dangling edges.

- [ ] **Step 4: Run unit and integration tests**

Run: `node --test tests/unit/timeline.test.js tests/unit/gates.test.js tests/integration/timeline.test.js`  
Expected: PASS for graph replacement, dependency readiness, invalid transitions, locked-node preservation, and fresh/stale evidence.

- [ ] **Step 5: Commit**

```bash
git add server/domain/timeline.js server/domain/gates.js server/application/timeline-service.js tests/unit tests/integration/timeline.test.js
git commit -m "feat: model timeline dependencies and evidence gates"
```

### Task 4: Hard Git and Worktree Safety

**Files:**
- Create: `server/domain/branch-policy.js`
- Create: `server/adapters/git.js`
- Create: `tests/helpers/git.js`
- Create: `tests/unit/branch-policy.test.js`
- Create: `tests/integration/git.test.js`

**Interfaces:**
- Produces: `assertMutableBranch({ actualBranch, assignedBranch, protectedBranches }) -> void`
- Produces: `GitAdapter.inspect(repoPath) -> { root, branch, headSha, isWorktree, dirty }`
- Produces: `GitAdapter.createRunWorktree({ repoPath, baseBranch, runId, parentDir }) -> Worktree`
- Produces: `GitAdapter.changedFiles({ worktreePath, baseSha }) -> string[]`
- Produces: `GitAdapter.removeRunWorktree(worktree, { force }) -> void`

- [ ] **Step 1: Write failing branch-attack tests**

```js
test('base, stable, and production branches are always immutable', () => {
  for (const branch of ['main', 'stable', 'production']) {
    assert.throws(
      () => assertMutableBranch({ actualBranch: branch, assignedBranch: 'work/run-7', protectedBranches: ['main', 'stable', 'production'] }),
      error => error.code === 'PROTECTED_BRANCH'
    );
  }
});

test('worktree execution is rejected after external branch switching', async () => {
  const fixture = await createGitFixture();
  const worktree = git.createRunWorktree({ ...fixture, runId: 'run-7' });
  await fixture.switchBranch(worktree.path, 'other-work');
  assert.throws(() => git.assertRunWorkspace(worktree), /assigned branch/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/unit/branch-policy.test.js tests/integration/git.test.js`  
Expected: FAIL because branch policy and Git adapter do not exist.

- [ ] **Step 3: Implement non-shell Git operations and preflight guards**

Use `execFile` with fixed Git subcommands and argument arrays. Resolve repository common directory, worktree root, symbolic branch, and HEAD before creation and before every mutation or provider launch. Name branches `work/pmcp-<run-id>` and reject if the base revision changes during setup.

- [ ] **Step 4: Verify safety tests**

Run: `node --test tests/unit/branch-policy.test.js tests/integration/git.test.js`  
Expected: PASS for protected branches, detached HEAD, dirty base, external branch switching, duplicate worktrees, and cleanup refusal with uncommitted work.

- [ ] **Step 5: Commit**

```bash
git add server/domain/branch-policy.js server/adapters/git.js tests/helpers/git.js tests/unit/branch-policy.test.js tests/integration/git.test.js
git commit -m "feat: enforce protected branches and isolated worktrees"
```

### Task 5: Claude Provider and Dependency-Aware Scheduler

**Files:**
- Create: `server/adapters/providers/process-runner.js`
- Create: `server/adapters/providers/claude.js`
- Create: `server/application/execution-service.js`
- Create: `tests/fixtures/fake-claude.js`
- Create: `tests/helpers/fake-provider.js`
- Create: `tests/integration/execution.test.js`

**Interfaces:**
- Produces: `ProcessRunner.start({ executable, args, cwd, input, envAllowlist, outputLimitBytes, signal }) -> RunningProcess`
- Produces: `ClaudeProvider.capabilities() -> ProviderCapabilities`
- Produces: `ClaudeProvider.start(request, observer) -> ProviderSession`
- Produces: `ClaudeProvider.draftTimeline({ goal, repositoryContext }, observer) -> TimelineDraft`
- Produces: `ExecutionService.start(projectId, nodeId, context) -> Run`
- Produces: `ExecutionService.draftTimeline(projectId, goal, context) -> TimelineDraft`
- Produces: `ExecutionService.schedule(projectId, context) -> Run[]`
- Produces: `ExecutionService.cancel(runId, context) -> Run`
- Produces: `ExecutionService.recoverInterrupted() -> Run[]`

- [ ] **Step 1: Write failing scheduler and process-boundary tests**

```js
test('automatic mode starts only ready nodes in the assigned worktree', async () => {
  const runs = await execution.schedule(project.id, context());
  assert.deepEqual(runs.map(run => run.nodeId), [readyNode.id]);
  assert.equal(provider.requests[0].cwd, runs[0].worktreePath);
});

test('provider launch never interpolates prompt text through a shell', async () => {
  const marker = join(tempDir, 'must-not-exist');
  await provider.start(request({ prompt: `hello; touch ${marker}` }), observer);
  assert.equal(existsSync(marker), false);
  assert.match(observer.output, /hello; touch/);
});

test('a drafted timeline is validated but remains proposed until accepted', async () => {
  const draft = await execution.draftTimeline(project.id, 'Ship the workstation', context());
  assert.equal(draft.status, 'proposed');
  assert.equal(timeline.get(project.id).nodes.length, 0);
});
```

- [ ] **Step 2: Run execution tests and verify RED**

Run: `node --test tests/integration/execution.test.js`  
Expected: FAIL because provider and execution modules do not exist.

- [ ] **Step 3: Implement process isolation, Claude adapter, and scheduler**

Launch Claude with `spawn(executable, args, { shell: false, cwd, env })`, send the prompt via stdin, cap persisted and streamed output, redact configured patterns, and terminate with SIGTERM followed by timed SIGKILL. Timeline drafting requests strict JSON matching the timeline schema, validates dependency acyclicity, and stores the result as a proposed draft until an explicit acceptance command. The scheduler uses timeline readiness and project interaction level; it records run lifecycle events and stops on blocking gates, provider failure, cancellation, or interruption.

- [ ] **Step 4: Verify execution and recovery**

Run: `node --test tests/integration/execution.test.js`  
Expected: PASS for ready ordering, dependency blocking, output streaming, redaction, limits, cancellation, non-zero exits, restart recovery, and branch preflight failure.

- [ ] **Step 5: Commit**

```bash
git add server/adapters/providers server/application/execution-service.js tests/fixtures tests/helpers/fake-provider.js tests/integration/execution.test.js
git commit -m "feat: run Claude through a gated execution scheduler"
```

### Task 6: Versioned HTTP API and Replayable Live Events

**Files:**
- Create: `server/app.js`
- Modify: `server/index.js`
- Create: `server/http/middleware.js`
- Create: `server/http/projects.js`
- Create: `server/http/timeline.js`
- Create: `server/http/executions.js`
- Create: `server/http/reviews.js`
- Create: `server/http/dashboard.js`
- Create: `server/application/dashboard-service.js`
- Create: `server/adapters/live-events.js`
- Create: `tests/integration/api.test.js`
- Create: `tests/integration/websocket.test.js`

**Interfaces:**
- Produces: `createApp(services, config) -> Express`
- Produces: `createServer({ app, eventStore, config }) -> http.Server`
- Produces: `LiveEvents.subscribe({ projectId, afterSequence, send, close }) -> unsubscribe`
- Consumes: project, timeline, execution, review, dashboard, and event services from Tasks 2–5.

- [ ] **Step 1: Write failing contract tests**

```js
test('validation errors use a stable envelope and request id', async () => {
  const response = await request(app).post('/api/v1/projects').set('Idempotency-Key', 'x').send({ name: '' });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'VALIDATION_FAILED');
  assert.ok(response.body.error.requestId);
});

test('a reconnect replays events after the client sequence', async () => {
  const received = await connectAndCollect(`/ws?projectId=${project.id}&after=2`, 2);
  assert.deepEqual(received.map(message => message.sequence), [3, 4]);
});
```

- [ ] **Step 2: Run API and WebSocket tests and verify RED**

Run: `node --test tests/integration/api.test.js tests/integration/websocket.test.js`  
Expected: FAIL because the versioned app and replay stream do not exist.

- [ ] **Step 3: Implement transports and lifecycle**

Add `/health`, `/ready`, and `/api/v1` routes for projects, proposed timeline drafts, accepted timelines, executions, evidence/reviews, issues, notes, and Git activity. Add JSON size limits, Helmet, request IDs, idempotency enforcement, typed error mapping, and correlation-safe logging. `DashboardService.syncGit` uses the guarded Git adapter and preserves the existing issue, note, tag, and cached commit workflows. Implement WebSocket `hello`, replay, event, heartbeat, resync-required, and close messages with bounded send buffers. Keep legacy `/api` routes disabled after migration.

- [ ] **Step 4: Verify transport contracts**

Run: `node --test tests/integration/api.test.js tests/integration/websocket.test.js`  
Expected: PASS for envelopes, limits, conflicts, health, replay, heartbeat, invalid subscriptions, and slow-client closure.

- [ ] **Step 5: Commit**

```bash
git add server/app.js server/index.js server/http server/application/dashboard-service.js server/adapters/live-events.js tests/integration/api.test.js tests/integration/websocket.test.js
git commit -m "feat: expose versioned API and replayable live events"
```

### Task 7: MCP Server With Policy Parity

**Files:**
- Create: `server/mcp/server.js`
- Create: `server/mcp/tools.js`
- Create: `tests/integration/mcp.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `createMcpServer(services) -> McpServer`
- Produces tools: `project_list`, `timeline_get`, `timeline_replace_draft`, `step_start`, `step_cancel`, `gate_submit_evidence`, `approval_decide`, `run_get`, `review_get`
- Consumes: the same service instances used by HTTP.

- [ ] **Step 1: Write failing MCP protocol tests**

```js
test('MCP and HTTP reject the same protected-branch execution', async () => {
  const httpError = await startThroughHttp(protectedProject);
  const mcpError = await startThroughMcp(protectedProject);
  assert.equal(httpError.code, 'PROTECTED_BRANCH');
  assert.equal(mcpError.code, httpError.code);
});

test('mutating MCP tools require idempotency keys', async () => {
  const result = await callTool('step_start', { projectId: project.id, nodeId: node.id });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /idempotencyKey/);
});
```

- [ ] **Step 2: Run MCP tests and verify RED**

Run: `node --test tests/integration/mcp.test.js`  
Expected: FAIL because the MCP server and tools do not exist.

- [ ] **Step 3: Implement stdio MCP tools**

Use Zod schemas for every tool, return compact structured content, map domain errors without stack traces, pass actor `mcp:<client-name>` into commands, and add `npm run mcp`. The MCP server imports application composition but never starts HTTP.

- [ ] **Step 4: Verify MCP contracts**

Run: `node --test tests/integration/mcp.test.js`  
Expected: PASS for discovery, reads, mutations, idempotency, branch protection, invalid graph input, and evidence policy.

- [ ] **Step 5: Commit**

```bash
git add server/mcp package.json package-lock.json tests/integration/mcp.test.js
git commit -m "feat: expose policy-safe MCP timeline tools"
```

### Task 8: Black-Glass Workstation Shell

**Files:**
- Modify: `public/index.html`
- Replace: `public/css/style.css`
- Create: `public/js/api.js`
- Create: `public/js/state.js`
- Create: `public/js/components.js`
- Replace: `public/js/app.js`
- Create: `tests/browser/workstation.spec.js`
- Create: `playwright.config.js`

**Interfaces:**
- Produces: `api.request(path, options) -> Promise<T>`
- Produces: `workstationState` with `subscribe`, `setProject`, `setRoute`, `applyEvent`, and `connectionState`
- Produces: `renderShell(state)`, `showToast(message, tone)`, `openDialog(content, options)`
- Consumes: `/api/v1/projects`, WebSocket replay protocol, and semantic browser navigation.

- [ ] **Step 1: Write failing browser shell tests**

```js
test('onboards a project and exposes keyboard navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connect your first project' })).toBeVisible();
  await page.getByLabel('Project name').fill('Workbench');
  await page.getByLabel('Repository path').fill(repoPath);
  await page.getByRole('button', { name: 'Connect project' }).click();
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});
```

- [ ] **Step 2: Run Playwright and verify RED**

Run: `npm run test:browser -- --grep "onboards a project"`  
Expected: FAIL because the workstation shell and accessible onboarding do not exist.

- [ ] **Step 3: Implement the shell and visual system**

Build a responsive app frame with project/header safety status, collapsible navigation, center workspace outlet, resizable activity rail, command palette, dialogs, toasts, skeletons, and connection banner. Use CSS custom properties for near-black layers, cyan/violet/green accents, 12–20px radii, subtle blur, fine borders, reduced-motion fallbacks, and compact developer typography. Eliminate inline styles and native prompts.

- [ ] **Step 4: Verify browser, accessibility, and responsive behavior**

Run: `npm run test:browser -- --grep "shell|onboards|keyboard|responsive"`  
Expected: PASS at desktop and mobile viewports with semantic landmarks, visible focus, and no horizontal page overflow.

- [ ] **Step 5: Commit**

```bash
git add public playwright.config.js tests/browser/workstation.spec.js
git commit -m "feat: create the black-glass workstation shell"
```

### Task 9: Interactive Timeline and Live Agent Rail

**Files:**
- Replace: `public/js/timeline.js`
- Replace: `public/js/agent.js`
- Modify: `public/js/state.js`
- Modify: `public/js/components.js`
- Modify: `public/css/style.css`
- Extend: `tests/browser/workstation.spec.js`

**Interfaces:**
- Produces: `renderTimeline(container, timeline, actions)`
- Produces: `renderActivityRail(container, runState, actions)`
- Consumes: timeline nodes/edges, gate state, live events, execution start/cancel APIs.

- [ ] **Step 1: Write failing timeline interaction tests**

```js
test('shows cross-milestone gates and follows live execution', async ({ page }) => {
  await seedTimeline({ edge: ['A-2', 'B-9'], gate: 'approval' });
  await page.goto('/#/timeline');
  await expect(page.getByText('A-2 gates B-9')).toBeVisible();
  await startRun('A-2');
  await expect(page.getByTestId('node-A-2')).toHaveAttribute('data-status', 'running');
  await expect(page.getByRole('complementary', { name: 'Agent activity' })).toContainText('A-2');
});

test('drafts a goal and requires acceptance before scheduling it', async ({ page }) => {
  await page.goto('/#/timeline');
  await page.getByLabel('Project goal').fill('Ship the workstation');
  await page.getByRole('button', { name: 'Draft timeline' }).click();
  await expect(page.getByText('Proposed timeline')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start automatic execution' })).toBeDisabled();
});
```

- [ ] **Step 2: Run focused Playwright test and verify RED**

Run: `npm run test:browser -- --grep "cross-milestone gates"`  
Expected: FAIL because the live dependency timeline does not exist.

- [ ] **Step 3: Implement timeline canvas and activity rail**

Render a goal composer and proposed-draft acceptance flow, then milestone lanes, step cards, dependency connectors, typed gate markers, status motion, progress summaries, filters, zoom density, keyboard selection, and an accessible dependency list. Bind events by project sequence. The activity rail shows provider status, current step, streamed sanitized output, evidence, blockers, and start/cancel/resume controls.

- [ ] **Step 4: Verify timeline behavior**

Run: `npm run test:browser -- --grep "timeline|agent activity|reconnect"`  
Expected: PASS for dependency rendering, event updates, blocked gates, cancel, replay after reconnect, keyboard selection, and reduced motion.

- [ ] **Step 5: Commit**

```bash
git add public/js/timeline.js public/js/agent.js public/js/state.js public/js/components.js public/css/style.css tests/browser/workstation.spec.js
git commit -m "feat: visualize live gated agent execution"
```

### Task 10: Overview, Reviews, and Safety Settings

**Files:**
- Replace: `public/js/dashboard.js`
- Create: `public/js/reviews.js`
- Create: `public/js/settings.js`
- Modify: `public/js/app.js`
- Modify: `public/css/style.css`
- Extend: `tests/browser/workstation.spec.js`

**Interfaces:**
- Produces: `renderDashboard(container, model, actions)`
- Produces: `renderReviews(container, bundle, actions)`
- Produces: `renderSettings(container, project, actions)`
- Consumes: project summary, Git activity, review bundle, approval, and policy APIs.

- [ ] **Step 1: Write failing review and safety UI tests**

```js
test('review center refuses stale evidence and explains why', async ({ page }) => {
  await seedReview({ evidenceSha: 'old', headSha: 'new' });
  await page.goto('/#/reviews');
  await expect(page.getByText('Evidence is stale')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve step' })).toBeDisabled();
});

test('settings always retains the base branch as protected', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.getByLabel('main protected')).toBeChecked();
  await expect(page.getByLabel('main protected')).toBeDisabled();
});
```

- [ ] **Step 2: Run focused browser tests and verify RED**

Run: `npm run test:browser -- --grep "review center|settings"`  
Expected: FAIL because review and settings views do not exist.

- [ ] **Step 3: Implement operational views**

Build overview metrics, active/blocked work, recent Git events, issues, notes, review diff summaries, test/build/visual evidence cards, approval decisions, interaction-level controls, provider diagnostics, and base/production/stable branch selection. Every safety control explains its effect; immutable base protection has no override.

- [ ] **Step 4: Verify workflows**

Run: `npm run test:browser -- --grep "overview|review center|settings|protected"`  
Expected: PASS for empty/populated states, stale evidence, approval notes, provider health, and protected-branch controls.

- [ ] **Step 5: Commit**

```bash
git add public/js/dashboard.js public/js/reviews.js public/js/settings.js public/js/app.js public/css/style.css tests/browser/workstation.spec.js
git commit -m "feat: add review center and safety controls"
```

### Task 11: Recovery, Operations, Documentation, and Release Gate

**Files:**
- Create: `server/application/backup-service.js`
- Create: `tests/integration/recovery.test.js`
- Create: `tests/integration/security.test.js`
- Modify: `README.md`
- Create: `.env.example`
- Create: `docs/architecture.md`
- Create: `docs/events.md`
- Create: `docs/mcp.md`
- Create: `docs/providers.md`
- Create: `docs/troubleshooting.md`
- Create: `AGENTS.md`

**Interfaces:**
- Produces: `BackupService.create(targetPath) -> BackupManifest`
- Produces: `BackupService.exportJson(targetPath) -> ExportManifest`
- Consumes: configuration, database, event, execution, provider, and Git modules.

- [ ] **Step 1: Write failing recovery and security tests**

```js
test('restart marks an orphaned active run interrupted without advancing its node', async () => {
  await seedRunningRun();
  const recovered = services.execution.recoverInterrupted();
  assert.equal(recovered[0].status, 'interrupted');
  assert.equal(services.timeline.getNode(recovered[0].nodeId).status, 'blocked');
});

test('non-loopback bind requires explicit opt-in', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /ALLOW_REMOTE_BIND/);
});
```

- [ ] **Step 2: Run recovery and security tests and verify RED**

Run: `node --test tests/integration/recovery.test.js tests/integration/security.test.js`  
Expected: FAIL for missing backup/recovery behavior and remote-bind policy.

- [ ] **Step 3: Implement operations and documentation**

Add startup recovery, graceful shutdown, provider readiness, SQLite backup with checksum manifest, versioned JSON export, retention configuration, structured redacted logging, and explicit remote-bind opt-in. Document setup, architecture boundaries, events, MCP tools, Claude/provider extension, local test folders, backup/restore, and troubleshooting. `AGENTS.md` requires feature/fix branches, isolated worktrees, TDD, full verification, and no automatic integration.

- [ ] **Step 4: Run the complete release gate**

Run: `npm run check`  
Expected: formatter/lint, unit, integration, MCP, and browser suites all pass with zero failures.

Run: `npm audit --omit=dev`  
Expected: zero known production vulnerabilities.

Run: `HOST=127.0.0.1 PORT=4177 npm start` and complete the documented health probe.  
Expected: `/health` returns process health, `/ready` reports database ready, and the browser loads the workstation without console errors.

- [ ] **Step 5: Inspect the final branch**

Run: `git diff --check main...HEAD && git status --short --branch && git log --oneline main..HEAD`  
Expected: no whitespace errors, clean worktree, and only reviewable feature commits.

- [ ] **Step 6: Commit**

```bash
git add server/application/backup-service.js tests/integration/recovery.test.js tests/integration/security.test.js README.md .env.example docs AGENTS.md
git commit -m "docs: complete workstation operations and release guidance"
```
