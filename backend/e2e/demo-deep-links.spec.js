const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('demo-deep-links') } });
  await seedOperationsData(server.baseURL);
});
test.afterAll(async () => stopOwnedTestServer(server));
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`direct Newsletter and Sponsors URLs open their screens at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setupPageWithAuth(page);
    // Bare /sponsors opens its default tab, /sponsors/queue.
    for (const [route, canonical, selector] of [
      ['newsletter', 'newsletter', '#newsletter-surface-title'],
      ['sponsors', 'sponsors/queue', '.sponsor-crm-surface'],
    ]) {
      await page.goto(`${server.baseURL}/${route}`);
      await expect(page).toHaveURL(`${server.baseURL}/${canonical}`);
      await expect(page.locator(selector)).toBeVisible();
      await page.reload();
      await expect(page.locator(selector)).toBeVisible();
    }
  });
}

test('direct entity query keeps validated parameters in the canonical hash URL', async ({ page }) => {
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks?date=2026-10-12&tracking=demo`);
  await expect(page).toHaveURL(`${server.baseURL}/tasks?date=2026-10-12`);
  await expect(page.locator('.ops-work-queue')).toBeVisible();
});
