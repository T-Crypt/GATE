import { expect, test } from '@playwright/test';

async function ensureProject(request) {
  const projects = await request.get('/api/v1/projects');
  const payload = await projects.json();
  if (payload.data.length > 0) return payload.data[0];
  const created = await request.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': 'browser-project' },
    data: {
      name: 'Workbench',
      repoPath: '/tmp/pmcp-browser-project',
      baseBranch: 'main',
      stableBranch: 'stable',
      productionBranch: 'production'
    }
  });
  return (await created.json()).data;
}

test('onboards a project and exposes keyboard-first workstation navigation', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Connect your first project' })).toBeVisible();
  await page.getByLabel('Project name').fill('Workbench');
  await page.getByLabel('Repository path').fill('/tmp/pmcp-browser-project');
  await page.getByLabel('Base branch').fill('main');
  await page.getByLabel('Stable branch').fill('stable');
  await page.getByLabel('Production branch').fill('production');
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
});
