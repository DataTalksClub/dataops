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
    // Bare /sponsors opens its default tab, /sponsors/pipeline.
    for (const [route, canonical, selector] of [
      ['newsletter', 'newsletter', '#newsletter-surface-title'],
      ['sponsors', 'sponsors/pipeline', '.sponsor-crm-surface'],
    ]) {
      await page.goto(`${server.baseURL}/${route}`);
      await expect(page).toHaveURL(`${server.baseURL}/${canonical}`);
      await expect(page.locator(selector)).toBeVisible();
      await page.reload();
      await expect(page.locator(selector)).toBeVisible();
    }
  });
}

test('a cold load of /newsletter/<issueId> opens the issue details, and unknown ids stay friendly', async ({ page }) => {
  await setupPageWithAuth(page);
  const created = await fetch(`${server.baseURL}/api/newsletter-issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'weekly',
      publicationDate: '2027-03-05',
      issueNumber: 990,
      status: 'drafting',
      slots: { primary: { sponsor: 'Deep Link Sponsor' }, secondary: {} },
    }),
  });
  const issue = await created.json();
  expect(created.status === 201 || created.status === 200, `issue seed: HTTP ${created.status}`).toBe(true);

  // Deep link on a cold load: the address is opened directly, not through the planner.
  await page.goto(`${server.baseURL}/newsletter/${issue.id}`);
  await expect(page).toHaveURL(`${server.baseURL}/newsletter/${issue.id}`);
  await expect(page.locator('#newsletter-issue-title')).toHaveText('Weekly #990');
  await expect(page.locator('[data-issue-details]')).toBeVisible();
  await expect(page.locator('.newsletter-issue-sponsors')).toContainText('Deep Link Sponsor');
  // A refresh resolves the same issue page again.
  await page.reload();
  await expect(page.locator('[data-issue-details]')).toBeVisible();

  // An unknown id keeps the friendly not-found state on a cold load.
  await page.goto(`${server.baseURL}/newsletter/00000000-0000-0000-0000-000000000000`);
  await expect(page.locator('[data-issue-notfound]')).toContainText('Newsletter issue not found');
  await expect(page.locator('[data-issue-notfound] a[href="/newsletter"]')).toBeVisible();
});

test('direct entity query keeps validated parameters in the canonical hash URL', async ({ page }) => {
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks?date=2026-10-12&tracking=demo`);
  await expect(page).toHaveURL(`${server.baseURL}/tasks?date=2026-10-12`);
  await expect(page.locator('.ops-work-queue')).toBeVisible();
});
