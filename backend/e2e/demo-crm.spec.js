const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

let server;
const screenshots = path.resolve(__dirname, '../../.tmp/demo-c-after');
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('demo-crm') } });
  await seedOperationsData(server.baseURL);
  const organizations = await (await fetch(`${server.baseURL}/api/sponsor-crm/organizations?limit=100`)).json();
  for (const [index, org] of organizations.items.entries()) {
    const response = await fetch(`${server.baseURL}/api/sponsor-crm/deals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId: org.id, status: index === 0 ? 'agreed' : 'open', productKind: index === 0 ? 'package' : 'one-off', amountEur: 1500, nextAction: { type: 'follow_up', due: '2026-10-20', owner: 'Grace' } }),
    });
    expect(response.ok).toBeTruthy();
  }
  fs.mkdirSync(screenshots, { recursive: true });
});
test.afterAll(async () => { await stopOwnedTestServer(server); });

for (const [width, height] of [[1440, 900], [1280, 800], [375, 667], [390, 844]]) {
  test(`Sponsor tabs separate company directory and leads at ${width}x${height}`, async ({ page }) => {
    await setupPageWithAuth(page);
    await page.setViewportSize({ width, height });
    await page.goto(`${server.baseURL}/#/sponsors`);
    await expect(page.locator('[data-crm-message]')).toBeHidden();
    await expect(page.locator('[data-crm-queue]')).toBeVisible();
    await expect(page.locator('[data-crm-companies-section]')).toBeHidden();
    await expect(page.locator('.crm-leads')).toBeHidden();
    await page.locator('[data-crm-view="companies"]').click();
    await expect(page.locator('[data-crm-companies-section]')).toBeVisible();
    await expect(page.locator('.crm-layout')).toBeHidden();
    const sponsorSearch = page.getByRole("searchbox", { name: "Search sponsors" });
    await expect(sponsorSearch).toBeVisible();
    const companyRows = page.locator("[data-crm-orgs] .crm-directory-row");
    const originalCompanyCount = await companyRows.count();
    await sponsorSearch.fill("Northwind Data");
    await expect(companyRows).toHaveCount(1);
    await expect(companyRows).toContainText("Northwind Data");
    await sponsorSearch.fill("");
    await expect(companyRows).toHaveCount(originalCompanyCount);
    await page.locator('[data-crm-view="leads"]').click();
    await expect(page.locator('.crm-leads')).toBeVisible();
    await expect(page.locator('[data-crm-companies-section]')).toBeHidden();
    await page.screenshot({ path: path.join(screenshots, `leads-${width}x${height}.png`) });
    await page.locator('[data-crm-view="pipeline"]').click();
    await expect(page.locator('[data-crm-bookings]')).toBeVisible();
    await expect(page.locator('[data-crm-bookings]')).not.toContainText('None');
    await page.screenshot({ path: path.join(screenshots, `pipeline-${width}x${height}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
