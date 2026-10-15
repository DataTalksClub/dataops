// The list–detail views (Templates, Sponsors) use the
// dakit split: the page never scrolls, each pane scrolls on its own, and a
// phone shows one pane at a time with Back.
const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const GRACE_ID = '00000000-0000-0000-0000-000000000001';
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
      nextAction: { type: 'follow_up', due: '2026-01-05', owner: GRACE_ID },
    });
  }
});
test.afterAll(async () => stopOwnedTestServer(server));

// Measures the page and both panes; scrolls each pane and reports whether the
// other pane (and the page) stayed where it was.
async function scrollReport(page) {
  return page.evaluate(() => {
    const main = document.querySelector('.dk-main');
    const [list, detail] = ['.dk-split__list', '.dk-split__detail'].map(
      (pane) => document.querySelector(`.dk-split:not([hidden]) > ${pane} .dk-split__scroll`),
    );
    const report = {
      page: document.scrollingElement.scrollHeight - innerHeight,
      main: main.scrollHeight - main.clientHeight,
      listOverflows: list.scrollHeight > list.clientHeight,
      detailOverflows: detail.scrollHeight > detail.clientHeight,
    };
    list.scrollTop = 200;
    report.listMoved = list.scrollTop;
    report.detailAfterList = detail.scrollTop;
    detail.scrollTop = 150;
    report.detailMoved = detail.scrollTop;
    report.listAfterDetail = list.scrollTop;
    report.mainAfter = main.scrollTop;
    return report;
  });
}

const VIEWS = [
  { route: '/sponsors', open: (page) => page.locator('.crm-master .dk-split__item').nth(10).click() },
];

for (const view of VIEWS) {
  test(`${view.route}: the page stays put while each pane scrolls on its own`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await setupPageWithAuth(page);
    await page.goto(`${server.baseURL}${view.route}`);
    await expect(page.locator('.dk-split')).toBeVisible();
    await view.open(page);
    await expect(page.locator('.dk-split')).toHaveAttribute('data-view', 'detail');
    await expect(page.locator('.dk-split__item[aria-current="true"]')).toHaveCount(1);
    await expect(page.locator('.dk-split__detail .dk-split__title')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.querySelector('.dk-split__detail .dk-split__scroll')?.scrollHeight || 0)).toBeGreaterThan(0);

    const report = await scrollReport(page);
    expect(report.page, 'the document never scrolls').toBe(0);
    expect(report.main, 'the content area never scrolls').toBe(0);
    expect(report.listOverflows, 'the seeded list is longer than its pane').toBe(true);
    expect(report.listMoved).toBe(200);
    expect(report.detailAfterList, 'scrolling the list leaves the detail alone').toBe(0);
    if (report.detailOverflows) {
      expect(report.detailMoved).toBe(150);
      expect(report.listAfterDetail, 'scrolling the detail leaves the list alone').toBe(200);
    }
    expect(report.mainAfter).toBe(0);

    // Choosing another record resets the detail even after the reader scrolled.
    await page.locator('.dk-split__list .dk-split__item').nth(1).click();
    await expect.poll(() => page.locator('.dk-split__detail .dk-split__scroll').evaluate(node => node.scrollTop)).toBe(0);

    // The selected row keeps the accent-soft fill and a neutral divider.
    const selected = await page.locator('.dk-split__item[aria-current="true"]').evaluate((row) => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--dk-accent-soft)';
      document.body.append(probe);
      const soft = getComputedStyle(probe).color;
      probe.remove();
      const style = getComputedStyle(row);
      return { soft, fill: style.backgroundColor, left: style.borderLeftWidth, top: style.borderTopWidth };
    });
    expect(selected.fill).toBe(selected.soft);
    expect([selected.left, selected.top]).toEqual(['0px', '0px']);
  });

  test(`${view.route}: a phone shows one pane at a time with Back`, async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await setupPageWithAuth(page);
    await page.goto(`${server.baseURL}${view.route}`);
    const list = page.locator('.dk-split__list');
    const detail = page.locator('.dk-split__detail');
    await expect(list).toBeVisible();
    await expect(detail).toBeHidden();
    await view.open(page);
    await expect(detail).toBeVisible();
    await expect(list).toBeHidden();
    const originText = await page.locator('.dk-split__item[aria-current="true"]').innerText();
    const back = page.locator('.dk-split__back');
    await expect(back).toBeVisible();
    expect((await back.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight)).toBe(0);
    await back.click();
    await expect(list).toBeVisible();
    await expect(detail).toBeHidden();
    await expect(page.locator('.dk-split__item').filter({ hasText: originText.replace(/\s+/g, ' ').trim() })).toBeFocused();
    await expect(page.locator('.dk-split__item').filter({ hasText: originText.replace(/\s+/g, ' ').trim() })).toBeInViewport();
  });
}

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
    await page.locator('.crm-master .dk-split__item').first().click();
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
