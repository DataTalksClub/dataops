const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('demo-operating-model', {
    'content/processes/demo-checklist.md': '---\ntitle: Demo checklist\ndoc_type: process\n---\n# Demo checklist\n\nA public-safe test fixture.\n',
  }) } });
  await seedOperationsData(server.baseURL);
});
test.afterAll(async () => stopOwnedTestServer(server));
for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
  test(`missing operating definitions offer Process Docs at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setupPageWithAuth(page);
    await page.goto(`${server.baseURL}/operating-model`);
    await expect(page.getByText("Definitions aren't available yet", { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    const out = path.resolve(__dirname, '../../.tmp/demo-b-after');
    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, `operating-model-${viewport.width}x${viewport.height}.png`) });
    await page.getByRole('button', { name: 'Browse Process Docs', exact: true }).click();
    await expect(page).toHaveURL(/\/processes/);
    await expect(page.getByText('Demo checklist', { exact: true }).first()).toBeVisible();
  });
}

test('connection failure can recover with explicit Retry', async ({ page }) => {
  await setupPageWithAuth(page);
  let fail = true;
  await page.route('**/api/operating-model', (route) => fail ? route.abort('failed') : route.continue());
  await page.goto(`${server.baseURL}/operating-model`);
  await expect(page.getByText('Operating model unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText(/Check your connection and retry/)).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText("Definitions aren't available yet", { exact: true })).toBeVisible();
});
