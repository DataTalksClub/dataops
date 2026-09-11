const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
const { berlinBusinessDate, offsetBusinessDate } = require('./helpers/business-date');

const screenshots = path.resolve(__dirname, '../../.tmp/screenshots/issue-223-after');
const owner = '00000000-0000-0000-0000-000000000001';
let server;
let tasks;

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(screenshots, { recursive: true });
  server = await startOwnedTestServer({ environment: {
    DTC_CACHE_ROOT: createDocsCacheRoot('issue-223-redesign'),
  } });
  tasks = [];
  const names = [
    'Confirm the workshop schedule', 'Review the draft announcement',
    'Check the publication checklist', 'Follow up on the review request',
    'Prepare the next session', 'Publish the approved notes',
    'Check the recording and add the remaining publication details',
    'Review the weekly task list',
  ];
  for (const [index, description] of names.entries()) {
    const response = await request.post(`${server.baseURL}/api/tasks`, { data: {
      description, assigneeId: owner,
      date: index < 3 ? offsetBusinessDate(Date.now(), -3 + index) : berlinBusinessDate(Date.now()),
      ...(index === 3 ? { status: 'waiting', waitingFor: 'Synthetic review',
        followUpAt: `${offsetBusinessDate(Date.now(), -2)}T12:00:00.000Z`,
        comment: 'Synthetic fixture' } : {}),
    } });
    expect(response.status(), await response.text()).toBe(201);
    tasks.push(await response.json());
  }
});

test.afterAll(async () => stopOwnedTestServer(server));

async function home(page) {
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/#/`);
  await expect(page.locator('.operations-home[data-operations-work-loaded="true"]')).toBeVisible();
}

async function accessible(page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
}

test('attention expansion preserves priorities, exact task return and planning journeys', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await home(page);
  await expect(page.locator('.home-attention-row')).toHaveCount(6);
  await expect(page.locator('.home-attention-count')).toHaveText('Showing 6 of 8');
  await expect(page.locator('.home-status-strip .surface-summary')).toHaveCount(0);
  const firstSix = await page.locator('.home-task-action').evaluateAll((buttons) => buttons.map((button) => button.dataset.taskId));
  await page.getByRole('button', { name: 'Show 2 more' }).click();
  await expect(page.locator('.home-attention-row')).toHaveCount(8);
  const all = await page.locator('.home-task-action').evaluateAll((buttons) => buttons.map((button) => button.dataset.taskId));
  expect(all.slice(0, 6)).toEqual(firstSix);
  expect(new Set(all).size).toBe(8);
  await expect(page.locator('.home-task-action').nth(6)).toBeFocused();
  const lastTask = tasks.find((task) => task.id === all[7]);
  await page.locator('.home-task-action').nth(7).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#task-panel-title')).toHaveText(lastTask.description);
  await page.locator('#task-panel-close').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.home-task-action').nth(7)).toBeFocused();
  await page.screenshot({ path: path.join(screenshots, 'task-return-expanded.png'), fullPage: true });
  await page.goBack();
  await expect(page.locator('#task-panel-title')).toHaveText(lastTask.description);
  await page.goForward();
  await expect(page.locator('.home-attention-row')).toHaveCount(8);
  await expect(page.locator('.home-task-action').nth(7)).toBeFocused();
  for (const [name, route, view = route] of [['My Plan', 'my-plan'], ['Inbox', 'inbox'], ['Process Docs', 'processes', 'docs']]) {
    await page.locator('.home-next-destinations').getByRole('button', { name: new RegExp(name) }).click();
    await expect(page).toHaveURL(new RegExp(`#/${route}`));
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-workspace-view', view);
    await page.goBack();
    await expect(page.locator('.home-attention-row')).toHaveCount(6);
  }
});

test('grouped navigation and scoped search remain usable in both themes and responsive layouts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await home(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.body.classList.toggle('dark', value === 'dark'); }, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.querySelectorAll('*').forEach((node) => { if (node.scrollTop) node.scrollTop = 0; });
    });
    await expect(page.getByRole('searchbox', { name: 'Search work and docs' })).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: path.join(screenshots, `home-desktop-${theme}.png`) });
    await page.getByRole('button', { name: 'Show 2 more' }).click();
    await accessible(page);
    await page.screenshot({ path: path.join(screenshots, `expanded-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Show fewer' }).click();
    await page.getByRole('button', { name: 'Hide sidebar' }).click();
    await page.evaluate(() => {
      document.querySelectorAll('*').forEach((node) => { if (node.scrollTop) node.scrollTop = 0; });
    });
    await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, `collapsed-${theme}.png`) });
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.querySelector('.page-shell').scrollTo(0, 0));
    await accessible(page);
    await page.screenshot({ path: path.join(screenshots, `home-mobile-${theme}.png`) });
    const firstRow = await page.locator('.home-attention-row').first().boundingBox();
    // The redesigned Home stacks the daily header, quick actions, and the
    // summary strip above the queue; the first row must still sit above the
    // fold on a 390x844 phone.
    expect(firstRow.y).toBeLessThan(500);
    await page.getByRole('button', { name: 'Open workspace' }).click();
    await expect(page.getByRole('button', { name: 'Close workspace' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('searchbox', { name: 'Search work and docs' })).toBeFocused();
    await accessible(page);
    await page.screenshot({ path: path.join(screenshots, `navigation-mobile-${theme}.png`) });
    if (await page.locator('#tasks-nav-button').getAttribute('aria-expanded') !== 'true') {
      await page.locator('#tasks-nav-button').click();
    }
    for (const section of ['queue', 'workflows', 'templates', 'recurring', 'assistants', 'artifacts']) {
      await expect(page.locator(`[data-tasks-section="${section}"]`)).toBeVisible();
      expect((await page.locator(`[data-tasks-section="${section}"]`).boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    await page.locator('#docs-nav-button').scrollIntoViewIfNeeded();
    await expect(page.locator('#docs-nav-button')).toBeInViewport();
    await page.screenshot({ path: path.join(screenshots, `navigation-bottom-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open workspace' })).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const search = page.getByRole('searchbox', { name: 'Search work and docs' });
  await search.fill('workshop');
  await search.press('Enter');
  await expect(page.locator('.unified-search-results')).toBeVisible();
  await expect(page.locator('.unified-search-results').getByRole('heading', { name: 'Confirm the workshop schedule', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'search-desktop.png') });
});

test('empty and partial sources keep useful destinations and recover through retry', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/work/api/tasks**', (route) => route.fulfill({ json: { tasks: [] } }));
  await home(page);
  await expect(page.locator('.home-attention-empty')).toContainText('No work needs your attention');
  await expect(page.locator('.home-attention-count')).toHaveText('Showing 0 of 0');
  await accessible(page);
  await page.screenshot({ path: path.join(screenshots, 'empty-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshots, 'empty-mobile.png'), fullPage: true });
  await page.unroute('**/work/api/tasks**');
  await page.route('**/work/api/cards**', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic cards outage' } }));
  await page.reload();
  await expect(page.locator('.surface-summary[data-summary-state="partial"]')).toBeVisible();
  await expect(page.locator('.surface-summary[data-summary-state="partial"]')).toContainText('Cards unavailable. Loaded work is still shown.');
  await expect(page.locator('.ops-runtime-state')).toHaveCount(0);
  await expect(page.locator('.surface-summary-detail')).toHaveCount(0);
  await expect(page.locator('.home-attention-count')).toHaveText('Showing 6 of 8 loaded');
  await expect(page.locator('.home-attention-row')).toHaveCount(6);
  expect((await page.locator('.home-attention-row').first().boundingBox()).y).toBeLessThan(600);
  await page.screenshot({ path: path.join(screenshots, 'partial-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await accessible(page);
  await page.screenshot({ path: path.join(screenshots, 'partial-desktop.png') });
  await page.unroute('**/work/api/cards**');
  await page.getByRole('button', { name: 'Retry loading work: Today' }).click();
  await expect(page.locator('.home-status-strip .surface-summary')).toHaveCount(0);
  await page.locator('.home-next-destinations').getByRole('button', { name: /Inbox/ }).click();
  await expect(page).toHaveURL(/#\/inbox/);
  await page.screenshot({ path: path.join(screenshots, 'inbox-desktop.png') });
});
