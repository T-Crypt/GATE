import { expect, test } from '@playwright/test';

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
