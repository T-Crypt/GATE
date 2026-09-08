# WebUI Tab De-duplication and Inline Feature Pass

**Date:** 2026-09-08
**Status:** Approved design, implementation in progress
**Target:** `public/` web UI (Overview, Issues, Git views)

## Problem

The original workstation design (`2026-09-07-localhost-developer-workstation-design.md`) calls
for seven distinct nav destinations: Overview, Timeline, Agent, Issues, Git, Reviews, Settings.
In the current implementation, `public/js/app.js` routes `overview`, `issues`, and `git` to the
same function, `initDashboard` (`public/js/dashboard.js`). All three render an identical page —
a metrics grid plus Issues, Git, and Notes panels together — differing only in which panel
receives `scrollIntoView()`. This is a functional regression against the documented design:
Issues and Git have no unique behavior of their own.

Separately, `GitAdapter.changedFiles()` (`server/adapters/git.js`) and the dirty/branch/HEAD
state returned by `GitAdapter.inspect()` are implemented and unit-tested at the adapter level
but never called by any application service or exposed in the UI.

## Goals

- Overview, Issues, and Git become three distinct views with no shared rendering path.
- Git surfaces real worktree state (branch, dirty/clean, HEAD sha) and a changed-files list,
  using the existing `GitAdapter` capability that was previously unused.
- Issues becomes a status-grouped board (Open / In Progress / Closed) with inline status
  editing, and absorbs the Notes panel (previously stranded on the shared dashboard with no
  nav destination of its own).
- Overview becomes a true read-only summary/landing page: metrics plus condensed recent-activity
  strips that link into the owning tab, with no mutation controls duplicated from Issues/Git.
- Visual language takes targeted accents from epiq (github.com/ljtn/epiq) — a dense, monospace,
  track-based layout — applied on top of the existing dark-glass/cyan-violet system in
  `public/css/style.css`, not a palette or full visual rewrite.

## Non-goals

- No changes to Timeline, Agent, Reviews, or Settings views or their styling.
- No new Git adapter methods beyond wiring up `inspect()` and `changedFiles()`, which already
  exist and are already tested.
- No diff line-count (`--numstat`) detail in the changed-files list — file paths only.

## Design

### Frontend

`public/js/dashboard.js` is retired and replaced with three focused modules, each owning its
own render/bind lifecycle exactly as `timeline.js`, `agent.js`, `reviews.js`, and `settings.js`
already do:

- **`overview.js`** — `initOverview(container, { project, api })`: metrics grid, then read-only
  strips of the 3-4 most recent issues, commits, and notes, each linking to its owning tab.
- **`issues.js`** — `initIssues(container, { project, api })`: add-issue form, a three-column
  status board (client-side grouped from the existing dashboard summary payload), and a Notes
  panel using the existing add-note flow.
- **`git.js`** — `initGit(container, { project, api })`: a status strip (branch, dirty/clean,
  HEAD sha), a changed-files list, and the existing sync button plus commit history restyled
  as a dense monospace "rail" list.

`app.js`'s route dispatch drops the grouped `['overview','issues','git'].includes(...)` branch
in favor of three separate calls, and the dead `focus`/`scrollIntoView` plumbing is removed.

### Backend

`DashboardService.summary()` becomes async and gains two fields, computed from adapter methods
that already exist:

```js
gitStatus: { branch, headSha, dirty }   // GitAdapter.inspect(project.repoPath)
changedFiles: string[]                   // GitAdapter.changedFiles({ worktreePath, baseSha })
```

`changedFiles` returns `[]` when there's no synced base commit to diff against, matching the
UI's existing empty-state conventions rather than erroring.

### Visual

New shared CSS components — `.rail-track`/`.rail-row` (dense monospace track rows, used by Git's
commit history), `.issues-board` (three-column grid), `.git-status-strip` (branch/dirty/HEAD
single-row summary) — added to `public/css/style.css` alongside the existing design tokens.
No new colors, fonts, or changes outside these additions and the removal of the now-unused
shared-dashboard grid rules.

## Testing

`tests/browser/workstation.spec.js` is updated to assert each of Overview, Issues, and Git
renders distinct, tab-specific DOM rather than a shared scrolled page. `tests/integration/dashboard.test.js`
gains coverage for the new `gitStatus`/`changedFiles` fields on `summary()`.

## Follow-up (explicitly out of scope here)

A dynamically-scaling Timeline view (2 to 20+ milestones, zoom-to-fit and zoom-to-milestone),
a click-to-drill-down interaction that expands a milestone into its constituent prompt/step
tiles, and a `create-timeline` Claude Code skill auto-installed to a project's local
`.claude/skills` that expands the user's original prompt into timeline/milestone structure.
This touches Timeline rendering and a new skill-packaging/install mechanism and will be
brainstormed and planned as its own design after this one ships.
