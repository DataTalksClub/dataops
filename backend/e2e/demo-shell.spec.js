const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('demo-shell') } });
  await seedOperationsData(server.baseURL);
});
test.afterAll(async () => stopOwnedTestServer(server));
for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
  test(`Process Docs remains reachable above the footer at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setupPageWithAuth(page);
    await page.goto(`${server.baseURL}/#/tasks`);
    await expect(page.locator('.ops-work-queue')).toBeVisible();
    if (viewport.width < 821) await page.locator('#mobile-menu-button').click();
    const docs = page.locator('#docs-nav-button');
    await docs.scrollIntoViewIfNeeded();
    const bottom = (await docs.boundingBox()).y + (await docs.boundingBox()).height;
    expect(bottom).toBeLessThanOrEqual((await page.locator('.sidebar-footer').boundingBox()).y);
    const out = path.resolve(__dirname, '../../.tmp/demo-b-after');
    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, `sidebar-${viewport.width}x${viewport.height}.png`) });
    await docs.click();
    await expect(page).toHaveURL(/#\/processes/);
  });
}
