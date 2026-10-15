// Sponsors > Leads at review scale: the tab opens on new leads, newest
// first, pages with Load more, and narrows by status, newsletter, search and
// sponsor. Synthetic intake data only.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const INTAKE_SECRET = 'sponsor-leads-review-secret';
const screenshots = process.env.LEADS_SCREENSHOT_DIR || path.resolve(__dirname, '../../.tmp/sponsor-leads');
const ISSUES = 32; // two sponsors per issue: 64 leads, more than one page
let server;

async function intake(messageId, newsletter, receivedAt, sponsors) {
  const response = await fetch(`${server.baseURL}/api/v1/intake/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dataops-intake-secret': INTAKE_SECRET },
    body: JSON.stringify({
      version: '2026-10-10',
      messageId,
      newsletter: { name: newsletter, sender: 'news@example.test', subject: `${newsletter} ${messageId}`, receivedAt },
      sponsors,
    }),
  });
  expect(response.ok).toBeTruthy();
}

test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: {
    DTC_CACHE_ROOT: createDocsCacheRoot('sponsor-leads-review'),
    EMAIL_DOCUMENT_INTAKE_SECRET: INTAKE_SECRET,
  } });
  for (let issue = 1; issue <= ISSUES; issue++) {
    const day = String(issue).padStart(2, '0');
    const newsletter = issue % 2 ? 'Synthetic Data Weekly' : 'Synthetic ML Digest';
    // One issue a day from 2026-08-01; issue 32 lands on 2026-09-01.
    const receivedAt = new Date(Date.UTC(2026, 7, issue, 8)).toISOString().replace('.000Z', 'Z');
    await intake(`synthetic-issue-${day}`, newsletter, receivedAt, [
      { name: 'Recurring Tools Co', url: 'https://recurring-tools.example/', blurb: 'Synthetic sponsor seen in every issue.' },
      { name: `One-off Vendor ${day}`, url: `https://vendor-${day}.example/`, blurb: `Synthetic one-off sponsor ${day}.` },
    ]);
  }
  // An issue with no paid placements is recorded but adds no lead.
  await intake('synthetic-issue-empty', 'Synthetic Data Weekly', '2026-09-02T08:00:00Z', []);
  fs.mkdirSync(screenshots, { recursive: true });
});
test.afterAll(async () => { await stopOwnedTestServer(server); });

async function openLeads(page) {
  await page.goto(`${server.baseURL}/sponsors/leads`);
  await expect(page.locator('[data-crm-message]')).toBeHidden();
  await expect(page.locator('.crm-leads')).toBeVisible();
}

test('Leads open on new leads, newest first, and page with Load more', async ({ page }) => {
  await setupPageWithAuth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLeads(page);
  await expect(page.getByRole('radio', { name: 'New' })).toHaveAttribute('aria-checked', 'true');
  const rows = page.locator('[data-crm-leads] .crm-lead-row');
  await expect(rows).toHaveCount(50);
  // Issue 32 is the newest (2026-09-01).
  await expect(rows.first()).toContainText('2026-09-01');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(rows).toHaveCount(64);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  await expect(rows.last()).toContainText('2026-08-01');

  // Ignoring a lead keeps it in place; the next load drops it from New.
  const ignored = rows.filter({ hasText: 'One-off Vendor 05' });
  await ignored.getByRole('button', { name: 'Ignore' }).click();
  const ignoreDialog = page.locator('[data-ignore-dialog]');
  await expect(ignoreDialog).toBeVisible();
  await ignoreDialog.getByRole('textbox', { name: 'Reason' }).fill('House ad, not a sponsor');
  await ignoreDialog.getByRole('button', { name: 'Ignore lead' }).click();
  await expect(ignoreDialog).toBeHidden();
  await expect(ignored.locator('.status-label')).toHaveText('Ignored');
  await expect(ignored.locator('[data-lead-reason]')).toContainText('House ad, not a sponsor');
  await page.getByRole('radio', { name: 'Ignored' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('One-off Vendor 05');
  await page.getByRole('radio', { name: 'New' }).click();
  await expect(rows).toHaveCount(50);
});

test('Leads narrow by newsletter, search and sponsor', async ({ page }) => {
  await setupPageWithAuth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLeads(page);
  const rows = page.locator('[data-crm-leads] .crm-lead-row');
  const newsletterPicker = page.locator('.crm-leads').getByRole('combobox', { name: /^Newsletter/ });
  const search = page.locator('.crm-leads').getByRole('searchbox', { name: 'Search' });
  await page.getByRole('radio', { name: 'All' }).click();
  await newsletterPicker.selectOption('Synthetic ML Digest');
  await expect(rows).toHaveCount(32);
  await expect(rows.filter({ hasText: 'Synthetic Data Weekly' })).toHaveCount(0);
  await search.fill('vendor-07');
  await expect(rows).toHaveCount(0);
  await newsletterPicker.selectOption('');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('One-off Vendor 07');
  await search.fill('');
  await expect(rows).toHaveCount(50);

  await page.getByRole('tab', { name: 'By sponsor' }).click();
  const recurring = rows.filter({ hasText: 'Recurring Tools Co' });
  await expect(recurring).toContainText('32 sightings');
  await expect(recurring).toContainText('Synthetic ML Digest, Synthetic Data Weekly');
  await recurring.getByRole('button', { name: 'Show sightings' }).click();
  await expect(page.getByRole('tab', { name: 'Sightings' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-crm-lead-scope]')).toContainText('Recurring Tools Co');
  await expect(rows).toHaveCount(32);
  await page.getByRole('button', { name: 'Show all sponsors' }).click();
  await expect(page.getByRole('tab', { name: 'By sponsor' })).toHaveAttribute('aria-selected', 'true');
});

for (const [width, height] of [[1440, 900], [390, 844]]) {
  test(`Leads tab fits ${width}x${height}`, async ({ page }) => {
    await setupPageWithAuth(page);
    await page.setViewportSize({ width, height });
    await openLeads(page);
    await expect(page.locator('[data-crm-leads] .crm-lead-row').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: path.join(screenshots, `leads-${width}x${height}.png`) });
    await page.getByRole('tab', { name: 'By sponsor' }).click();
    await expect(page.locator('[data-lead-group]').first()).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, `leads-by-sponsor-${width}x${height}.png`) });
  });
}
