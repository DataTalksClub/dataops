const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

let server;
const pipelineStageFixtures = new Map();
const INTAKE_SECRET = 'demo-crm-synthetic-intake-secret';
const screenshots = path.resolve(__dirname, '../../.tmp/demo-c-after');
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: {
    DTC_CACHE_ROOT: createDocsCacheRoot('demo-crm'),
    EMAIL_DOCUMENT_INTAKE_SECRET: INTAKE_SECRET,
    SPONSOR_FINANCE_ENABLED: 'true',
  } });
  await seedOperationsData(server.baseURL);
  const leadResponse = await fetch(`${server.baseURL}/api/v1/intake/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dataops-intake-secret': INTAKE_SECRET },
    body: JSON.stringify({
      version: '2026-10-10',
      messageId: 'demo-crm-synthetic-newsletter-lead',
      newsletter: {
        name: 'Synthetic Newsletter', sender: 'news@synthetic.example',
        subject: 'Synthetic sponsor spotlight', receivedAt: new Date().toISOString(),
      },
      sponsors: [{
        name: 'Synthetic Newsletter Lead', url: 'https://synthetic-lead.example/catalog',
        category: 'tool', blurb: 'Synthetic analytics tooling sponsor for a newsletter campaign.',
        context: 'Seen in a synthetic newsletter sponsor slot.',
      }],
    }),
  });
  expect(leadResponse.ok).toBeTruthy();
  const organizations = await (await fetch(`${server.baseURL}/api/sponsor-crm/organizations?limit=100`)).json();
  for (const [index, org] of [...organizations.items, organizations.items[0]].entries()) {
    const response = await fetch(`${server.baseURL}/api/sponsor-crm/deals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId: org.id, status: index === 0 ? 'open' : 'agreed', productKind: index === 1 ? 'package' : index === 2 ? 'course' : 'one-off', amountEur: 1500 + index * 500 }),
    });
    expect(response.ok).toBeTruthy();
    const createdDeal = await response.json();
    pipelineStageFixtures.set(createdDeal.id, ["open", "agreed", "invoiced", "delivered"][index]);
  }
  fs.mkdirSync(screenshots, { recursive: true });
});
test.afterAll(async () => { await stopOwnedTestServer(server); });

for (const [width, height] of [[1440, 900], [1280, 800], [375, 667], [390, 844]]) {
  test(`Sponsor tabs separate company directory and leads at ${width}x${height}`, async ({ page }) => {
    await setupPageWithAuth(page);
    await page.setViewportSize({ width, height });
    await page.route("**/api/sponsor-crm/deals?*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.items = payload.items.map((deal) => {
        const stage = pipelineStageFixtures.get(deal.id);
        if (!stage) return deal;
        return {
          ...deal,
          money: stage === "invoiced" ? "invoiced" : stage === "delivered" ? "paid" : "none",
          fulfillment: stage === "delivered" ? "delivered" : "none",
        };
      });
      await route.fulfill({ response, json: payload });
    });
    await page.goto(`${server.baseURL}/sponsors`);
    await expect(page.locator('[data-crm-message]')).toBeHidden();
    await expect(page.locator('[data-crm-bookings]')).toBeVisible();
    await expect(page.locator('[data-dir-root="companies"]')).toBeHidden();
    await expect(page.locator('.crm-leads')).toBeHidden();
    // Primary nav: Pipeline · Companies · People, secondary views under More.
    await expect(page.locator('[data-crm-nav-tab="pipeline"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-crm-nav-tab="people"]')).toBeVisible();
    await page.locator('[data-crm-nav-tab="companies"]').click();
    await expect(page).toHaveURL(/\/sponsors\/companies/);
    await expect(page.locator('[data-dir-root="companies"]')).toBeVisible();
    await expect(page.locator('.crm-layout')).toBeHidden();
    const sponsorSearch = page.getByRole("searchbox", { name: "Search companies" });
    await expect(sponsorSearch).toBeVisible();
    const companyRows = page.locator('[data-dir-root="companies"] [data-dir-company]');
    await expect(companyRows.first()).toBeVisible();
    const originalCompanyCount = await companyRows.count();
    await sponsorSearch.fill("Northwind Data");
    await expect(page).toHaveURL(/search=Northwind/);
    await expect(companyRows).toHaveCount(1);
    await expect(companyRows).toContainText("Northwind Data");
    await sponsorSearch.fill("");
    await expect(companyRows).toHaveCount(originalCompanyCount);
    // Saved views come from the server, never browser storage.
    await expect(page.locator('[data-dir-root="companies"] [data-views-select]')).toBeVisible();
    // Secondary views (leads, newsletters, money) live under More.
    await page.locator('[data-crm-nav-more] > summary').click();
    await page.locator('[data-crm-nav-tab="leads"]').click();
    await expect(page.locator('.crm-leads')).toBeVisible();
    await expect(page.locator('[data-dir-root="companies"]')).toBeHidden();
    const lead = page.locator('.crm-lead-row').filter({ hasText: 'Synthetic Newsletter Lead' });
    await expect(lead).toBeVisible();
    if (width <= 600) {
      const rowBox = await lead.boundingBox();
      const bodyBox = await lead.locator('.crm-lead-body').boundingBox();
      const actionsBox = await lead.locator('.crm-lead-actions').boundingBox();
      expect(bodyBox.width).toBeGreaterThan(rowBox.width * 0.75);
      expect(actionsBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: path.join(screenshots, `leads-${width}x${height}.png`) });
    await page.locator('[data-crm-nav-tab="pipeline"]').click();
    await expect(page.locator('[data-crm-bookings]')).toBeVisible();
    // The funnel is a bounded table: company/contact, stage, next action.
    // Seeded deals carry no tasks, so the default actionable view is honestly
    // empty; All deals shows the seeded funnel.
    await expect(page.locator('[data-crm-bookings]')).toContainText('No matching deals');
    await page.locator('[data-pipeline-view]').selectOption('all');
    const funnelRows = page.locator('[data-crm-bookings] tbody tr');
    await expect(funnelRows.first()).toBeVisible();
    // Stage totals filter the same bounded rows.
    await page.locator('[data-pipeline-status="invoiced"]').click();
    await expect(page).toHaveURL(/stage=invoiced/);
    await page.locator('.crm-filter-disclosure > summary').click();
    await expect(page.locator('[data-crm-status]')).toBeVisible();
    await expect(page.locator('[data-crm-status]')).toHaveValue("invoiced");
    await page.locator('[data-crm-status]').selectOption('');
    await expect(page).toHaveURL(/\/sponsors\/pipeline\?view=all$/);
    await page.screenshot({ path: path.join(screenshots, `pipeline-${width}x${height}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // Add deal rides on the Pipeline list head, never the page header.
    await page.getByRole('button', { name: 'Add deal', exact: true }).click();
    await expect(page.locator('[data-deal-dialog]')).toBeVisible();
    await expect(page.locator('.sponsor-crm-surface')).not.toHaveClass(/has-booking-detail/);
    await page.locator('[data-deal-dialog] button[value="cancel"]').click();
    await page.locator('[data-crm-bookings] [data-open-deal]').first().click();
    // The record opens progressively: identity header plus tabs, Back returns.
    // Finance evidence loads only when its tab opens.
    const detail = page.locator('[data-crm-detail]');
    await expect(detail.locator('[data-crm-record]')).toBeVisible();
    await expect(detail.locator('[data-record-title]')).toBeVisible();
    await expect(detail.locator('[data-record-tabs][role="tablist"]')).toBeVisible();
    const financeRequest = page.waitForRequest((request) => /\/api\/sponsor-crm\/deals\/[^/]+\/finance$/.test(new URL(request.url()).pathname));
    await detail.locator('[data-record-tab="finance"]').click();
    expect(new URL((await financeRequest).url()).pathname).toMatch(/^\/api\/sponsor-crm\/deals\//);
    await expect(detail.locator('[data-finance-panel]')).toBeVisible();
    await expect(page.locator(".crm-master")).toBeHidden();
    await page.locator('[data-record-back]').click();
    await expect(page.locator('.crm-master')).toBeVisible();
    await expect(page.locator('[data-crm-bookings]')).toBeVisible();
    await expect(page.locator('.sponsor-crm-surface')).not.toHaveClass(/has-booking-detail/);
    await page.screenshot({ path: path.join(screenshots, `company-${width}x${height}.png`) });
  });
}

// Run after the populated-lead viewport journeys so those still audit review actions.
test('converted leads stay complete after reload at desktop and mobile sizes', async ({ page }) => {
  await setupPageWithAuth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server.baseURL}/sponsors`);
  await expect(page.locator('[data-crm-message]')).toBeHidden();
  await page.locator('[data-crm-nav-more] > summary').click();
  await page.locator('[data-crm-nav-tab="leads"]').click();
  const lead = page.locator('.crm-lead-row').filter({ hasText: 'Synthetic Newsletter Lead' });
  await expect(lead.getByRole('button', { name: 'Convert', exact: true })).toBeVisible();
  await lead.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(lead.locator('.status-label')).toHaveText('Converted');
  for (const [width, height] of [[1440, 900], [1280, 800], [375, 667]]) {
    await page.setViewportSize({ width, height });
    await page.reload();
    await expect(page.locator('[data-crm-message]')).toBeHidden();
    await page.locator('[data-crm-nav-more] > summary').click();
    await page.locator('[data-crm-nav-tab="leads"]').click();
    // The Leads tab opens on New; converted leads sit under their own filter.
    await page.getByRole('radio', { name: 'Converted' }).click();
    await expect(lead.locator('.status-label')).toHaveText('Converted');
    await expect(lead.locator('[data-lead-status]')).toHaveCount(0);
    await expect(lead.locator('.crm-lead-actions')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: path.join(screenshots, `lead-converted-${width}x${height}.png`) });
  }
});
