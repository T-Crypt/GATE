# Graph Report - GATE  (2026-09-09)

## Corpus Check
- Corpus is ~39,084 words - fits in a single context window. You may not need a graph.

## Summary
- 495 nodes · 1312 edges · 23 communities (18 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 29 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Provider Adapters
- Frontend UI
- Event Store
- Project Service
- Package Config
- Express App
- OpenCode Provider
- Zvec-Grep Config
- Review Service
- Git Adapter
- Dashboard Service
- Live Events
- Service Composition
- Server Entry
- MCP Server
- Backup Service
- Server Config
- MCP Stdio
- API Routes
- Lint Scripts

## God Nodes (most connected - your core abstractions)
1. `AppError` - 53 edges
2. `escapeHtml()` - 40 edges
3. `EventStore` - 26 edges
4. `runIdempotent()` - 26 edges
5. `createTestDatabase()` - 24 edges
6. `ProjectService` - 23 edges
7. `GitAdapter` - 21 edges
8. `buildServices()` - 21 edges
9. `validation()` - 21 edges
10. `renderView()` - 19 edges

## Surprising Connections (you probably didn't know these)
- `setup()` --calls--> `GitAdapter`  [EXTRACTED]
  tests/integration/execution.test.js → server/adapters/git.js
- `setup()` --calls--> `GitAdapter`  [EXTRACTED]
  tests/integration/remote.test.js → server/adapters/git.js
- `unitProvider()` --calls--> `OpenCodeProvider`  [EXTRACTED]
  tests/unit/opencode-provider.test.js → server/adapters/providers/opencode.js
- `adapterWithFetch()` --calls--> `GithubRemoteAdapter`  [EXTRACTED]
  tests/unit/remote-github.test.js → server/adapters/remote/github.js
- `setup()` --calls--> `createApp()`  [EXTRACTED]
  tests/integration/api.test.js → server/app.js

## Import Cycles
- None detected.

## Communities (23 total, 2 thin omitted)

### Community 0 - "Provider Adapters"
Cohesion: 0.06
Nodes (33): safeRunId(), ClaudeProvider, isEmptyObject(), parseStructuredOutput(), timelineSchema, ProcessRunner, GithubRemoteAdapter, parseOrigin() (+25 more)

### Community 1 - "Frontend UI"
Cohesion: 0.08
Nodes (70): initActivity(), runRow(), activeStatuses, appendLiveActivity(), initAgent(), renderActivityRail(), runCard(), activeProject() (+62 more)

### Community 2 - "Event Store"
Cohesion: 0.09
Nodes (24): decode(), EventStore, TimelineService, config, afterCommit(), openDatabase(), transactionState, withTransaction() (+16 more)

### Community 3 - "Project Service"
Cohesion: 0.12
Nodes (15): branchPrefix(), canonicalRepository(), decodeProject(), normalizePolicy(), optionalBranch(), ProjectService, text(), ensureGateIgnored() (+7 more)

### Community 4 - "Package Config"
Cohesion: 0.05
Nodes (32): dependencies, express, helmet, @modelcontextprotocol/sdk, pino, ws, zod, description (+24 more)

### Community 5 - "Express App"
Cohesion: 0.18
Nodes (27): express, zod, createApp(), moduleDir, publicDir, dashboardRouter(), issueInput, issueUpdate (+19 more)

### Community 6 - "OpenCode Provider"
Cohesion: 0.14
Nodes (10): DEFAULT_MODEL, isEmptyObject(), OpenCodeProvider, parseStructuredOutput(), resolveExecutable(), resolveFromShim(), stripCodeFence(), FakeRunner (+2 more)

### Community 7 - "Zvec-Grep Config"
Cohesion: 0.12
Nodes (16): createdTime, embedding, dimension, metric, model, provider, embeddingRuntime, device (+8 more)

### Community 8 - "Review Service"
Cohesion: 0.29
Nodes (7): cleanText(), decodeApproval(), decodeEvidence(), ReviewService, safeArtifactPath(), evidenceIsFresh(), GATE_TYPES

### Community 9 - "Git Adapter"
Cohesion: 0.26
Nodes (5): committedGitignore(), execFileAsync, git(), GitAdapter, isOnlyGateIgnoreChange()

### Community 11 - "Live Events"
Cohesion: 0.22
Nodes (8): ws, createHttpServer(), send(), app, config, db, server, services

### Community 12 - "Service Composition"
Cohesion: 0.31
Nodes (3): buildServices(), FakeProvider, setup()

### Community 13 - "Server Entry"
Cohesion: 0.20
Nodes (8): app, config, db, logger, migrationVersion, recovered, server, services

### Community 14 - "MCP Server"
Cohesion: 0.31
Nodes (8): createMcpServer(), actorContext(), graph, handler(), idempotencyKey, projectId, registerTools(), success()

### Community 15 - "Backup Service"
Cohesion: 0.43
Nodes (3): BackupService, checksum(), prepareTarget()

### Community 16 - "Server Config"
Cohesion: 0.43
Nodes (5): DEFAULT_DOTENV, integer(), loadConfig(), loadEnvFromDotenv(), LOOPBACK_HOSTS

### Community 17 - "MCP Stdio"
Cohesion: 0.29
Nodes (5): config, db, server, services, transport

### Community 18 - "API Routes"
Cohesion: 0.47
Nodes (4): api, ApiError, idempotencyKey(), request()

## Knowledge Gaps
- **97 isolated node(s):** `manifestVersion`, `id`, `name`, `path`, `rootPaths` (+92 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 148 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AppError` connect `Provider Adapters` to `Event Store`, `Project Service`, `Express App`, `OpenCode Provider`, `Review Service`, `Git Adapter`?**
  _High betweenness centrality (0.109) - this node is a cross-community bridge._
- **Why does `buildServices()` connect `Service Composition` to `Provider Adapters`, `Event Store`, `Project Service`, `OpenCode Provider`, `Review Service`, `Git Adapter`, `Dashboard Service`, `Live Events`, `Server Entry`, `Backup Service`, `MCP Stdio`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Why does `supertest` connect `Package Config` to `Server Config`, `Event Store`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **What connects `manifestVersion`, `id`, `name` to the rest of the system?**
  _97 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Provider Adapters` be split into smaller, more focused modules?**
  _Cohesion score 0.058823529411764705 - nodes in this community are weakly interconnected._
- **Should `Frontend UI` be split into smaller, more focused modules?**
  _Cohesion score 0.07875404055245372 - nodes in this community are weakly interconnected._
- **Should `Event Store` be split into smaller, more focused modules?**
  _Cohesion score 0.08636363636363636 - nodes in this community are weakly interconnected._