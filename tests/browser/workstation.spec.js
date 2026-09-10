import { expect, test } from '@playwright/test';

async function ensureProject(request) {
  const projects = await request.get('/api/v1/projects');
  const payload = await projects.json();
  if (payload.data.length > 0) return payload.data[0];
  const created = await request.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': 'browser-project' },
    data: {
      name: 'Workbench',
      repoPath: '/tmp/gate-browser-project',
      baseBranch: 'main',
      stableBranch: 'stable',
      productionBranch: 'production'
    }
  });
  return (await created.json()).data;
}

async function createProject(request, key, name) {
  const created = await request.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': key },
    data: {
      name,
      repoPath: '/tmp/gate-browser-project',
      baseBranch: 'main',
      stableBranch: 'stable',
      productionBranch: 'production'
    }
  });
  return (await created.json()).data;
}

// The model list comes from whichever harness CLI is installed on the machine
// running the tests. Stub it so these assertions describe Gate's behaviour
// rather than the box's toolchain.
async function stubModels(page, models, extra = {}) {
  await page.route('**/api/v1/providers/*/models', async (route) => {
    const kind = new URL(route.request().url()).pathname.split('/').at(-2);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { kind, authenticated: true, models, ...extra }, meta: { apiVersion: 'v1' } })
    });
  });
}

test('onboards a project and exposes keyboard-first workstation navigation', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Connect your first project' })).toBeVisible();
  await page.getByLabel('Project name').fill('Workbench');
  await page.getByLabel('Repository path').fill('/tmp/gate-browser-project');
  await expect(page.getByLabel('Branch naming prefix')).toHaveValue('work/gate-');
  await expect(page.getByLabel('Stable branch')).toHaveCount(0);
  await expect(page.getByLabel('Production branch')).toHaveCount(0);
  await page
    .getByRole('dialog', { name: 'Connect your first project' })
    .getByRole('button', { name: 'Connect project' })
    .click();

  await expect(page.getByRole('banner')).toContainText('Workbench');
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Agent activity' })).toBeVisible();

  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByRole('option', { name: 'Open timeline' }).click();
  await expect(page).toHaveURL(/#\/timeline$/);
  await expect(page.getByRole('heading', { name: 'Interactive timeline', exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test('collapses navigation without creating horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/timeline');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('shows cross-milestone gates and follows live execution', async ({ page, request }) => {
  const project = await ensureProject(request);
  await request.put(`/api/v1/projects/${project.id}/timeline`, {
    headers: { 'Idempotency-Key': 'browser-timeline' },
    data: {
      nodes: [
        { id: 'milestone-a', key: 'A', kind: 'milestone', title: 'Foundation', ordinal: 0 },
        { id: 'step-a-2', key: 'A-2', kind: 'step', parentId: 'milestone-a', title: 'Build event policy', ordinal: 1 },
        { id: 'milestone-b', key: 'B', kind: 'milestone', title: 'Interface', ordinal: 1 },
        { id: 'step-b-9', key: 'B-9', kind: 'step', parentId: 'milestone-b', title: 'Render review state', ordinal: 8 }
      ],
      edges: [
        { id: 'edge-a2-b9', fromNodeId: 'step-a-2', toNodeId: 'step-b-9', type: 'approval_gate' }
      ],
      gates: []
    }
  });

  await page.goto('/#/timeline');
  await expect(page.getByText('A-2 gates B-9')).toBeVisible();
  await page.getByRole('button', { name: 'Run A-2' }).click();
  await expect(page.getByTestId('node-step-a-2')).toHaveAttribute('data-status', /running|review/);
  await expect(page.getByRole('complementary', { name: 'Agent activity' })).toContainText('A-2');

  const milestoneA = page.locator('.milestone-lane[data-node-id="milestone-a"]');
  await expect(milestoneA.locator('.badge')).toContainText(/running|review/);

  await page.goto('/#/activity');
  await expect(page.getByText('A-2 · Build event policy')).toBeVisible();
});

test('review center refuses stale evidence and explains why', async ({ page, request }) => {
  const project = await createProject(request, 'browser-review-project', 'Review fixture');
  await request.put(`/api/v1/projects/${project.id}/timeline`, {
    headers: { 'Idempotency-Key': 'browser-review-timeline' },
    data: {
      nodes: [
        { id: 'review-milestone', key: 'R', kind: 'milestone', title: 'Review' },
        { id: 'review-step', key: 'R-1', kind: 'step', parentId: 'review-milestone', title: 'Visual review' }
      ],
      edges: [],
      gates: [{ id: 'review-gate', nodeId: 'review-step', type: 'approval', title: 'Human approval' }]
    }
  });
  await request.post(`/api/v1/projects/${project.id}/gates/review-gate/evidence`, {
    headers: { 'Idempotency-Key': 'browser-stale-evidence' },
    data: { kind: 'visual', headSha: 'old', artifactPath: 'screenshots/review.png' }
  });

  await page.goto('/#/reviews');
  await page.getByLabel('Active project').selectOption(String(project.id));
  await expect(page.getByText('Evidence is stale')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve step' })).toBeDisabled();
});

test('settings always retains the base branch as protected', async ({ page, request }) => {
  await ensureProject(request);
  await page.goto('/#/settings');
  await expect(page.getByLabel('main protected')).toBeChecked();
  await expect(page.getByLabel('main protected')).toBeDisabled();
});

test('project settings persist lifecycle stage and expose managed instructions', async ({ page, request }) => {
  const project = await ensureProject(request);
  await request.patch(`/api/v1/projects/${project.id}/stage`, {
    headers: { 'Idempotency-Key': 'browser-stage-active' },
    data: { stage: 'active' }
  });

  await page.goto('/#/settings');
  await page.getByLabel('Active project').selectOption(String(project.id));
  await page.getByLabel('Project stage').selectOption('maintenance');
  await page.getByRole('button', { name: 'Save project stage' }).click();
  await expect(page.getByLabel('Project stage')).toHaveValue('maintenance');

  await expect(page.getByRole('heading', { name: 'Project instructions' })).toBeVisible();
  await page.getByLabel('Instruction file').selectOption('CLAUDE.md');
  await page.getByLabel('User project instructions').fill('# Delivery rules\n\nRun targeted tests.');
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await expect(page.getByText('Managed GATE contract')).toBeVisible();
});

test('can switch the provider backend and pick a model the harness reports', async ({ page, request }) => {
  const project = await ensureProject(request);
  await stubModels(page, [{ id: 'opencode/big-pickle', label: 'opencode/big-pickle — default' }]);
  await page.goto('/#/settings');
  await page.getByLabel('Active project').selectOption(String(project.id));
  await page.getByLabel('Backend provider').selectOption('opencode');
  // The model field is a picker, never free text — a typed id only fails much
  // later, at draft time.
  await expect(page.getByLabel('Model')).toHaveJSProperty('tagName', 'SELECT');
  await page.getByLabel('Model').selectOption('opencode/big-pickle');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.getByLabel('Backend provider')).toHaveValue('opencode');
  await expect(page.getByLabel('Model')).toHaveValue('opencode/big-pickle');
});

test('a provider that cannot list its models takes a typed model id', async ({ page, request }) => {
  const project = await createProject(request, 'browser-open-catalog', 'Open catalog');
  // `complete: false` means the list is a suggestion. The field has to accept an
  // id that is not on it, or a model the CLI reaches fine is unreachable here.
  await stubModels(page, [{ id: 'auto', label: 'auto — routed by task complexity' }], { complete: false });
  await page.goto('/#/settings');
  await page.getByLabel('Active project').selectOption(String(project.id));
  await page.getByLabel('Backend provider').selectOption('codex');
  await expect(page.getByLabel('Model')).toHaveJSProperty('tagName', 'INPUT');
  await page.getByLabel('Model').fill('gpt-6-astra');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.getByLabel('Backend provider')).toHaveValue('codex');
  await expect(page.getByLabel('Model')).toHaveValue('gpt-6-astra');
});

test('the settings page names which backends this machine can reach', async ({ page, request }) => {
  const project = await ensureProject(request);
  await stubModels(page, [{ id: 'opus', label: 'Opus' }], { complete: false });
  // The roster probes six real CLIs, so it is stubbed for the same reason the
  // model catalog is: these assertions are about Gate, not about this box.
  await page.route('**/api/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          providers: [
            { kind: 'claude', availability: 'ready', structuredDrafts: true, canDraft: true, models: 4, modelsComplete: false },
            { kind: 'cursor', availability: 'unreachable', structuredDrafts: false, canDraft: true, models: 0, modelsComplete: true }
          ],
          checkedAt: '2026-09-10T00:00:00.000Z'
        },
        meta: { apiVersion: 'v1' }
      })
    });
  });
  await page.goto('/#/settings');
  await page.getByLabel('Active project').selectOption(String(project.id));

  await expect(page.getByText('Claude Code · signed in')).toBeVisible();
  // "not detected" rather than "not installed": the probe cannot tell a missing
  // executable from a signed-out one.
  await expect(page.getByText('Cursor Agent · not detected')).toBeVisible();
});

test('a configured model the harness cannot reach is shown as unavailable', async ({ page, request }) => {
  const project = await createProject(request, 'browser-stale-model', 'Stale model');
  await request.patch(`/api/v1/projects/${project.id}/provider`, {
    headers: { 'Idempotency-Key': 'browser-stale-model-provider' },
    data: { providerKind: 'claude', providerConfig: { model: 'Sonnet 5' } }
  });
  await stubModels(page, [{ id: 'sonnet', label: 'Sonnet — balanced' }]);
  await page.goto('/#/settings');
  await page.getByLabel('Active project').selectOption(String(project.id));
  await expect(page.getByLabel('Model')).toHaveValue('Sonnet 5');
  await expect(page.locator('#providerModelSetting option[selected]')).toContainText('unavailable');
});

test('timeline draft form preselects the OpenCode default model', async ({ page, request }) => {
  const project = await ensureProject(request);
  await stubModels(page, [{ id: 'opencode/big-pickle', label: 'opencode/big-pickle — default' }]);
  await request.patch(`/api/v1/projects/${project.id}/provider`, {
    headers: { 'Idempotency-Key': 'browser-provider-opencode' },
    data: { providerKind: 'opencode', providerConfig: { model: 'opencode/big-pickle' } }
  });
  await page.goto('/#/timeline');
  await page.getByLabel('Active project').selectOption(String(project.id));
  await expect(page.getByText('OpenCode planning')).toBeVisible();
  await expect(page.getByLabel('Draft model')).toHaveValue('opencode/big-pickle');
});

test('can connect and switch between multiple projects', async ({ page, request }) => {
  const first = await ensureProject(request);
  await page.goto('/');
  await expect(page.getByRole('banner')).toContainText(first.name);

  await page.getByRole('button', { name: 'Connect another project' }).click();
  await expect(page.getByRole('heading', { name: 'Connect a project' })).toBeVisible();
  await page.getByLabel('Project name').fill('Second Project');
  await page.getByLabel('Repository path').fill('/tmp/gate-browser-project');
  await page
    .getByRole('dialog', { name: 'Connect a project' })
    .getByRole('button', { name: 'Connect project' })
    .click();

  await expect(page.getByRole('banner')).toContainText('Second Project');
  const select = page.getByLabel('Active project');
  await expect(select).toHaveValue(/.+/);
  await select.selectOption({ label: first.name });
  await expect(page.getByRole('banner')).toContainText(first.name);
});

test('accent color choice persists across reloads without touching status colors', async ({ page, request }) => {
  await ensureProject(request);
  await page.goto('/#/settings');

  await expect(page.locator('html')).not.toHaveAttribute('data-accent', /.+/);
  await page.getByRole('radio', { name: 'Purple' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'purple');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'purple');
  await expect(page.getByRole('radio', { name: 'Purple' })).toHaveAttribute('aria-checked', 'true');
});

test('overview, issues, and git render distinct views instead of one shared dashboard', async ({ page, request }) => {
  await ensureProject(request);

  await page.goto('/#/overview');
  await expect(page.getByRole('heading', { name: 'Recent issues' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent commits' })).toBeVisible();
  await expect(page.locator('#issuesPanel')).toHaveCount(0);
  await expect(page.locator('#gitPanel')).toHaveCount(0);
  await expect(page.getByPlaceholder('Capture a local work item')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Sync/ })).toHaveCount(0);

  await page.goto('/#/issues');
  await expect(page.locator('#issuesPanel')).toBeVisible();
  await expect(page.getByPlaceholder('Capture a local work item')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(page.locator('#gitPanel')).toHaveCount(0);

  await page.goto('/#/git');
  await expect(page.locator('#gitPanel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync remote' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync main' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Commits', exact: true })).toBeVisible();
  await expect(page.locator('#issuesPanel')).toHaveCount(0);
  await expect(page.getByPlaceholder('Capture a local work item')).toHaveCount(0);
});

test('a successful draft shows its plan and restores the draft button', async ({ page, request }) => {
  const project = await ensureProject(request);
  // Stub the provider round-trip: this test is about what the UI does with a
  // draft, not about which model produced it.
  await page.route('**/timeline/drafts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'draft-1',
          projectId: project.id,
          graph: {
            nodes: [
              { id: 'm1', key: 'M1', kind: 'milestone', title: 'Foundation', parentId: null },
              { id: 's1', key: 'M1.1', kind: 'step', title: 'Scaffold', parentId: 'm1' },
              { id: 's2', key: 'M1.2', kind: 'step', title: 'Test', parentId: 'm1' }
            ],
            edges: [{ fromNodeId: 's1', toNodeId: 's2', type: 'depends_on' }],
            gates: [{ nodeId: 's2', type: 'test', title: 'Suite green' }]
          }
        },
        meta: { apiVersion: 'v1' }
      })
    });
  });

  await page.goto('/#/timeline');
  await page.getByLabel('Active project').selectOption(String(project.id));
  await page.locator('#goalInput').fill('Build a hello world CLI');
  const draftButton = page.getByRole('button', { name: 'Draft timeline' });
  await draftButton.click();

  await expect(page.getByText('Proposed timeline')).toBeVisible();
  await expect(page.getByText('1 milestones · 2 steps · 1 dependencies · 1 gates')).toBeVisible();
  await expect(page.locator('.draft-outline li')).toHaveText([/M1\s*Foundation\s*2 steps/]);
  await expect(page.getByRole('button', { name: 'Accept draft' })).toBeVisible();
  // The reported symptom: the button stayed greyed on "Drafting…" after success.
  await expect(draftButton).toBeEnabled();
});

test('a failed draft explains itself instead of silently resetting', async ({ page, request }) => {
  const project = await ensureProject(request);
  await page.route('**/timeline/drafts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'PROVIDER_FAILED', message: 'Claude timeline drafting failed' } })
    });
  });

  await page.goto('/#/timeline');
  await page.getByLabel('Active project').selectOption(String(project.id));
  await page.locator('#goalInput').fill('Build a hello world CLI');
  const draftButton = page.getByRole('button', { name: 'Draft timeline' });
  await draftButton.click();

  await expect(page.locator('.draft-error')).toContainText('Claude timeline drafting failed');
  await expect(draftButton).toBeEnabled();
});

test('a run started against a drifted plan keeps its warning on screen', async ({ page, request }) => {
  const project = await createProject(request, 'browser-stale-plan', 'Drifted plan fixture');
  await request.put(`/api/v1/projects/${project.id}/timeline`, {
    headers: { 'Idempotency-Key': 'browser-stale-plan-timeline' },
    data: {
      nodes: [
        { id: 'drift-milestone', key: 'D', kind: 'milestone', title: 'Drifted work' },
        { id: 'drift-step', key: 'D-1', kind: 'step', parentId: 'drift-milestone', title: 'Change cancellation' }
      ],
      edges: [],
      gates: []
    }
  });
  // The service already computes planWarnings; the defect was purely that the
  // page threw the response away. Stub the start so the assertion is about
  // what the UI renders, not about provider timing.
  await page.route(`**/api/v1/projects/${project.id}/runs`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'stub-run', projectId: project.id, nodeId: 'drift-step', status: 'running',
          planWarnings: [{
            projectId: project.id,
            planningRequestId: '11111111-1111-4111-8111-111111111111',
            status: 'STALE',
            reason: '1 file this plan was grounded on changed: src/provider.js.',
            changedGroundingFiles: ['src/provider.js']
          }]
        },
        meta: { apiVersion: 'v1' }
      })
    });
  });

  await page.goto('/#/timeline');
  await page.getByLabel('Active project').selectOption(String(project.id));
  await page.getByRole('button', { name: 'Run D-1' }).click();

  const warning = page.getByTestId('plan-warnings');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('STALE');
  await expect(warning).toContainText('src/provider.js');
  await expect(warning.getByRole('button', { name: 'Re-ground milestone' })).toBeVisible();

  // A toast would already be gone; the warning must survive the re-render the
  // live event stream triggers, and a trip through another view.
  await page.getByRole('link', { name: 'Overview' }).click();
  await page.getByRole('link', { name: 'Timeline' }).click();
  await expect(page.getByTestId('plan-warnings')).toContainText('STALE');

  await page.getByTestId('plan-warnings').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('plan-warnings')).toHaveCount(0);
});

test('the planning inbox lists what needs a decision and dismissing clears it', async ({ page, request }) => {
  const project = await createProject(request, 'browser-inbox', 'Inbox fixture');
  const item = {
    key: 'plan_stale:11111111-1111-4111-8111-111111111111',
    kind: 'plan_stale',
    title: 'Accepted feature plan has drifted',
    detail: '1 file this plan was grounded on changed: src/provider.js.',
    subject: 'Change provider cancellation',
    route: 'features',
    planningRequestId: '11111111-1111-4111-8111-111111111111',
    staleness: { status: 'STALE', changedGroundingFiles: ['src/provider.js'] },
    actions: ['analyze', 'reground', 'convert', 'dismiss']
  };
  let dismissed = false;
  await page.route(`**/api/v1/projects/${project.id}/inbox`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          projectId: project.id,
          items: dismissed ? [] : [item],
          counts: dismissed ? {} : { plan_stale: 1 },
          stalenessTruncated: false,
          stalenessCheckLimit: 25
        },
        meta: { apiVersion: 'v1' }
      })
    });
  });
  await page.route(`**/api/v1/projects/${project.id}/inbox/*/dismiss`, async (route) => {
    dismissed = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { projectId: project.id, itemKey: item.key }, meta: { apiVersion: 'v1' } })
    });
  });

  await page.goto('/#/inbox');
  await page.getByLabel('Active project').selectOption(String(project.id));
  const row = page.locator(`[data-inbox-item="${item.key}"]`);
  await expect(row).toContainText('Accepted feature plan has drifted');
  await expect(row.locator('.badge.staleness.stale')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Re-ground plan' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Convert to issue' })).toBeVisible();

  await row.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator(`[data-inbox-item="${item.key}"]`)).toHaveCount(0);
  await expect(page.getByText('Nothing is waiting on you')).toBeVisible();
});

test('memory leads with Ask and keeps the graph tools behind one disclosure', async ({ page, request }) => {
  await ensureProject(request);
  await page.goto('/#/memory');

  // Ask is the primary entry point, so it is the first panel on the page.
  const panels = page.locator('.memory-grid > *');
  await expect(panels.first()).toContainText('Ask memory');
  await expect(page.getByRole('heading', { name: 'Ask memory' })).toBeVisible();

  // Exploration tools open on intent; the page does not lead with them.
  const overviewButton = page.getByRole('button', { name: 'Load overview' });
  await expect(overviewButton).toBeHidden();
  await page.locator('.memory-exploration > summary').click();
  await expect(overviewButton).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Path', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Neighborhood' })).toBeVisible();

  // The overview is a whole-graph analysis, so its cost is stated up front.
  await expect(overviewButton.locator('xpath=..')).toContainText(/\d+ nodes/);
  await expect(page.locator('#memoryOverviewResults')).toContainText('up to 5,000 nodes');
});
