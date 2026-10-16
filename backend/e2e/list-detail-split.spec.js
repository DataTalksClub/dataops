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

// Sponsors has no list pane of its own: the Pipeline board is the list, and
// opening a deal replaces the board with the deal's detail.
test('/sponsors: opening a pipeline deal replaces the board with its detail', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/sponsors`);
  await expect(page).toHaveURL(/\/sponsors\/pipeline$/);
  await expect(page.locator('[data-crm-message]')).toBeHidden();
  await page.locator('[data-crm-bookings] .crm-pipeline-card').first().getByRole('button', { name: 'Open deal' }).click();
  await expect(page).toHaveURL(/\/sponsors\/deals\//);
  await expect(page.locator('.crm-master')).toBeHidden();
  const title = page.locator('.dk-split__detail .dk-split__title');
  await expect(title).toBeVisible();
  await expect(title).toBeInViewport();
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
  test(`Sponsors section jumps clear the sticky nav in ${theme} at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setupPageWithAuth(page);
    await page.addInitScript(t => localStorage.setItem('dakit-theme', t), theme);
    await page.goto(`${server.baseURL}/sponsors`);
    await page.locator('[data-crm-bookings] .crm-pipeline-card').first().getByRole('button', { name: 'Open deal' }).click();
    const nav = page.locator('.booking-section-nav');
    await expect(nav).toBeVisible();
    const appearance = await nav.locator('[aria-pressed="true"]').evaluate(node => {
      const style = getComputedStyle(node);
      const probe = document.createElement('i'); probe.style.color = 'var(--dk-border-default)';
      document.body.append(probe); const neutral = getComputedStyle(probe).color; probe.remove();
      return { border: style.borderTopColor, neutral, outline: style.outlineStyle, focusVisible: node.matches(':focus-visible') };
    });
    expect(appearance.border).toBe(appearance.neutral);
    expect(appearance.focusVisible).toBe(false);
    expect(appearance.outline).toBe('none');
    for (const section of ['history', 'overview']) {
      await nav.locator(`[data-booking-section-link="${section}"]`).click();
      await expect.poll(() => page.locator(`#booking-${section}`).evaluate(node =>
        Math.round(node.getBoundingClientRect().top - document.querySelector('.booking-section-nav').getBoundingClientRect().bottom))).toBeGreaterThanOrEqual(0);
    }
  });
}
