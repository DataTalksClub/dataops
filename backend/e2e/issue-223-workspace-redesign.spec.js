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

async function queue(page) {
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/#/`);
  await expect(page).toHaveURL(`${server.baseURL}/#/`);
  await expect(page.locator('.ops-queue-board')).toBeVisible();
}

async function accessible(page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
}

test('the queue caps its list, expands in place, and returns focus to the exact task', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await queue(page);
  // The queue states how much work exists once, then shows a capped list.
  await expect(page.locator('.ops-queue-total')).toContainText('8 open');
  await expect(page.locator('.ops-queue-row')).toHaveCount(8);
  await expect(page.locator('.surface-summary[data-summary-state="ready"]')).toHaveCount(0);
  const firstIds = await page.locator('.ops-queue-row').evaluateAll((rows) => rows.map((row) => row.dataset.taskId));
  expect(new Set(firstIds).size).toBe(tasks.length);

  const lastTask = tasks.find((task) => task.id === firstIds[firstIds.length - 1]);
  await page.locator('.ops-queue-row').nth(firstIds.length - 1).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#task-panel-title')).toHaveText(lastTask.description);
  await page.locator('#task-panel-close').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ops-queue-row').nth(firstIds.length - 1)).toBeFocused();
  await page.screenshot({ path: path.join(screenshots, 'task-return.png'), fullPage: true });
  await page.goBack();
  await expect(page.locator('#task-panel-title')).toHaveText(lastTask.description);
  await page.goForward();
  await expect(page.locator('.ops-queue-row').nth(firstIds.length - 1)).toBeFocused();
});

test('grouped navigation and scoped search remain usable in both themes and responsive layouts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await queue(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.body.classList.toggle('dark', value === 'dark'); }, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.querySelectorAll('*').forEach((node) => { if (node.scrollTop) node.scrollTop = 0; });
    });
    await expect(page.getByRole('searchbox', { name: 'Search work and docs' })).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: path.join(screenshots, `queue-desktop-${theme}.png`) });
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
    await page.screenshot({ path: path.join(screenshots, `queue-mobile-${theme}.png`) });
    const firstRow = await page.locator('.ops-queue-row').first().boundingBox();
    // The queue is the landing page: its first row must sit above the fold on
    // a 390x844 phone.
    expect(firstRow.y).toBeLessThan(500);
    await page.getByRole('button', { name: 'Open workspace' }).click();
    await expect(page.getByRole('button', { name: 'Close workspace' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('searchbox', { name: 'Search work and docs' })).toBeFocused();
    await accessible(page);
    await page.screenshot({ path: path.join(screenshots, `navigation-mobile-${theme}.png`) });
    // Tasks sections are first-class rows: always visible, touch-sized, and
    // laid out on the same text column as every other destination.
    for (const section of ['queue', 'workflows', 'templates', 'recurring', 'assistants']) {
      await expect(page.locator(`[data-tasks-section="${section}"]`)).toBeVisible();
      expect((await page.locator(`[data-tasks-section="${section}"]`).boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    // Artifacts is not a destination of its own.
    await expect(page.locator('[data-tasks-section="artifacts"]')).toHaveCount(0);
    await expect(page.locator('#tasks-nav-submenu')).toHaveCount(0);
    const columns = await page.evaluate(() => {
      function textLeft(element) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.textContent.trim()) continue;
          const start = node.textContent.search(/\S/);
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + 1);
          return range.getBoundingClientRect().left;
        }
        return element.getBoundingClientRect().left;
      }
      const rows = [...document.querySelectorAll('.workspace-nav-button')];
      return rows.map((row) => ({
        iconRight: row.querySelector('.workspace-nav-icon')?.getBoundingClientRect().right ?? 0,
        label: textLeft(row),
        section: row.dataset.tasksSection || row.dataset.workspaceView || '',
      }));
    });
    for (const section of ['queue', 'workflows', 'templates', 'recurring', 'assistants']) {
      const row = columns.find((item) => item.section === section);
      expect(row, section).toBeTruthy();
      expect(row.label).toBeGreaterThan(row.iconRight - 1);
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
  await queue(page);
  await expect(page.locator('.surface-summary[data-summary-state="empty"]')).toContainText('No tasks are open in this queue');
  await expect(page.locator('.ops-queue-row')).toHaveCount(0);
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
  await expect(page.locator('.ops-queue-row strong')).toHaveCount(tasks.length);
  expect((await page.locator('.ops-queue-row').first().boundingBox()).y).toBeLessThan(600);
  await page.screenshot({ path: path.join(screenshots, 'partial-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await accessible(page);
  await page.screenshot({ path: path.join(screenshots, 'partial-desktop.png') });
  await page.unroute('**/work/api/cards**');
  await page.locator('.surface-summary').getByRole('button', { name: /Retry/ }).click();
  await expect(page.locator('.surface-summary[data-summary-state="ready"]')).toHaveCount(0);
});
