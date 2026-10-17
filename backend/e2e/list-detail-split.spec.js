// The list–detail views (Templates, Sponsors) use the dakit split: the page
// never scrolls and a phone shows one pane at a time with Back.
const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
let server;

function processDoc(index) {
  const steps = Array.from({ length: 24 }, (_, step) => `${step + 1}. Synthetic step ${step + 1}: check, record and confirm.`).join('\n');
  return `---\ntitle: Synthetic process ${index}\ndoc_type: process\nstatus: active\n---\n\n# Synthetic process ${index}\n\n${steps}\n`;
}

async function post(path, body) {
  const response = await fetch(`${server.baseURL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `${path} ${response.status}`).toBeTruthy();
  return response.json();
}

test.beforeAll(async () => {
  const docs = {};
  for (let index = 1; index <= 24; index += 1) docs[`content/processes/split-${index}.md`] = processDoc(index);
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('list-detail-split', docs) } });
  await seedOperationsData(server.baseURL);
  for (let index = 1; index <= 20; index += 1) {
    const organization = await post('/api/sponsor-crm/organizations', { displayName: `Split Sponsor ${index}`, domain: `split-${index}.example` });
    await post('/api/sponsor-crm/deals', {
      organizationId: (organization.organization || organization).id,
      status: 'open',
      productKind: 'one-off',
      amountEur: 1000 + index,
    });
  }
});
test.afterAll(async () => stopOwnedTestServer(server));

// Sponsors has no list pane of its own: the Pipeline funnel table is the
// list, and opening a deal replaces the board with the deal's detail.
// Hundreds of alerts fold into one line, so they never push the deal down
// the page.
test('/sponsors: opening a pipeline deal replaces the board with its detail', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await setupPageWithAuth(page);
  const alerts = Array.from({ length: 300 }, (_, index) => ({
    id: `alert-${index}`, message: `Synthetic sponsor alert ${index}`, dismissed: false, dueAt: '2026-08-20',
    metadata: { sponsorDealId: `deal-${index}`, sponsorAlertRule: 'performance-follow-up-due' },
  }));
  await page.route('**/api/notifications*', (route) => route.fulfill({ json: { notifications: { items: alerts } } }));
  await page.goto(`${server.baseURL}/sponsors`);
  await expect(page.locator('[data-crm-alert-summary]')).toHaveText('300 sponsor alerts');
  await expect(page.locator('.crm-alerts')).not.toHaveAttribute('open', '');
  await expect(page.locator('[data-crm-bookings] tbody tr').first()).toBeInViewport();
  await expect(page).toHaveURL(/\/sponsors\/pipeline$/);
  await expect(page.locator('[data-crm-message]')).toBeHidden();
  await page.locator('[data-crm-bookings] [data-open-deal]').first().click();
  await expect(page).toHaveURL(/\/sponsors\/deals\//);
  await expect(page.locator('.crm-master')).toBeHidden();
  const title = page.locator('.dk-split__detail .dk-split__title');
  await expect(title).toBeVisible();
  await expect(title).toBeInViewport();
  await expect(page.locator('.crm-alerts')).toBeHidden();
});

test('/templates: list and preview share the split and the page stays put', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/templates`);
  await expect(page.locator('.runtime-template-projection .dk-split__empty')).toContainText('Choose a template');
  await page.locator('.runtime-template-row').first().click();
  await expect(page.locator('.dk-split')).toHaveAttribute('data-view', 'detail');
  await expect(page.locator('.runtime-template-row[aria-current="true"]')).toHaveCount(1);
  const report = await page.evaluate(() => {
    const main = document.querySelector('.dk-main');
    return { page: document.scrollingElement.scrollHeight - innerHeight, main: main.scrollHeight - main.clientHeight };
  });
  expect(report).toEqual({ page: 0, main: 0 });

  await page.setViewportSize(MOBILE);
  await expect(page.locator('.dk-split__list')).toBeHidden();
  await page.getByRole('button', { name: 'Back to Templates' }).click();
  await expect(page.locator('.dk-split__list')).toBeVisible();
  await expect(page.locator('.runtime-template-row').first()).toBeFocused();
});

for (const theme of ['light', 'dark']) for (const viewport of [DESKTOP, MOBILE]) {
  test(`Sponsors record tabs switch panels without moving the page in ${theme} at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setupPageWithAuth(page);
    await page.addInitScript(t => localStorage.setItem('dakit-theme', t), theme);
    await page.goto(`${server.baseURL}/sponsors`);
    await page.locator('[data-crm-bookings] [data-open-deal]').first().click();
    const tabs = page.locator('[data-record-tabs][role="tablist"]');
    await expect(tabs).toBeVisible();
    const before = await page.evaluate(() => document.scrollingElement.scrollTop);
    for (const tab of ['people', 'activity', 'deals', 'finance']) {
      await tabs.locator(`[data-record-tab="${tab}"]`).click();
      await expect(tabs.locator(`[data-record-tab="${tab}"]`)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(`[data-record-panel="${tab}"]`)).toBeVisible();
    }
    expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(before);
    // Keyboard moves through tabs without leaving the tablist.
    await tabs.locator('[data-record-tab="overview"]').click();
    await tabs.locator('[data-record-tab="overview"]').press('ArrowRight');
    await expect(tabs.locator('[data-record-tab="people"]')).toBeFocused();
  });
}
