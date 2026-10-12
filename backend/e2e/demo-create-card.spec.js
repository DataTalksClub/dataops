const path = require('node:path');
const { test, expect } = require('@playwright/test');
const repoRoot = process.env.DEMO_CREATE_REPO_ROOT || path.resolve(__dirname, '../..');
const helpers = path.join(repoRoot, 'backend/e2e/helpers');
const { setupPageWithAuth } = require(path.join(helpers, 'auth'));
const { seedOperationsData } = require(path.join(helpers, 'seed-operations-data'));
const { startOwnedTestServer, stopOwnedTestServer } = require(path.join(helpers, 'isolated-capability-server'));
const frontendRoot = process.env.DEMO_CREATE_FRONTEND_ROOT || path.join(repoRoot, 'frontend');
let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { FRONTEND_ROOT: frontendRoot } });
  await seedOperationsData(server.baseURL);
});
test.afterAll(async () => { if (server) await stopOwnedTestServer(server); });
for (const [width, height] of [[1440, 900], [1280, 800], [375, 667], [390, 844]]) {
  test(`Create card remains readable and closes on canonical navigation ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await setupPageWithAuth(page);
    await page.goto(`${server.baseURL}/#/cards`);
    await page.getByRole('button', { name: 'Create card', exact: true }).click();
    const dialog = page.locator('.quick-form-panel');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Date', { exact: true })).toHaveValue(/\d{4}-\d{2}-\d{2}/);
    await expect(dialog.locator('select')).toBeEnabled();
    expect(await dialog.locator('select option').count()).toBeGreaterThan(1);
    await expect(dialog).not.toContainText('template available');
    const field = await dialog.getByLabel('Card title (optional)').boundingBox();
    const panel = await dialog.boundingBox();
    expect(field.width).toBeGreaterThan(panel.width * 0.8);
    const header = await dialog.locator('.quick-form-header').boundingBox();
    expect(Math.abs(header.width - panel.width)).toBeLessThan(3);
    await page.screenshot({ path: path.resolve(repoRoot, `.tmp/demo-audit/create-canonical-${width}x${height}.png`) });
    // Activate the real application nav handler while the modal overlays it.
    await page.locator('[data-tasks-section="templates"]').evaluate((button) => button.click());
    await expect(page).toHaveURL(/#\/templates$/);
    await expect(page.locator('.quick-form-overlay')).toHaveCount(0);
    await page.goto(`${server.baseURL}/#/cards`);
    await page.getByRole('button', { name: 'Create card', exact: true }).click();
    await page.goBack();
    await expect(page.locator('.quick-form-overlay')).toHaveCount(0);
  });
}
