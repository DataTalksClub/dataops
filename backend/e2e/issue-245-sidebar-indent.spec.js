const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require('./helpers/isolated-capability-server');

const screenshots = path.resolve(__dirname, '../../.tmp/screenshots/issue-245');
const TASK_SECTIONS = ['queue', 'workflows', 'templates', 'recurring', 'assistants'];
let server;

test.beforeAll(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  server = await startOwnedTestServer({
    environment: {
      DTC_CACHE_ROOT: createDocsCacheRoot('issue-245-sidebar-indent'),
    },
  });
});

test.afterAll(async () => stopOwnedTestServer(server));

async function useTheme(page, dark) {
  await page.evaluate((on) => {
    document.documentElement.dataset.theme = on ? 'dark' : 'light';
    localStorage.setItem('dakit-theme', on ? 'dark' : 'light');
  }, dark);
}

async function openWorkspace(page) {
  await setupPageWithAuth(page);
  const response = await page.goto(`${server.baseURL}/#/`);
  assertOwnedServerResponse(server, response, 'issue-245 queue');
  await expect(page.locator('.ops-queue-board')).toBeVisible();
  // The Tasks sections are first-class rows, so they need no expansion.
  for (const section of TASK_SECTIONS) {
    await expect(page.locator(`[data-tasks-section="${section}"]`)).toBeVisible();
  }
  await expect(page.locator('#tasks-nav-submenu')).toHaveCount(0);
}

async function tasksLabelAlignment(page) {
  return page.evaluate(() => {
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

    // Every nav row is one shape: an icon, then a label. Tasks sections are
    // measured against a non-Tasks destination to prove the shared column.
    const rowText = (row) => ({
      icon: row.querySelector('.workspace-nav-icon')?.getBoundingClientRect(),
      labelX: textLeft(row),
    });
    const queue = rowText(document.querySelector('[data-tasks-section="queue"]'));
    const newsletter = rowText(document.querySelector('[data-workspace-view="newsletter"]'));
    return {
      labelsX: [...document.querySelectorAll('[data-tasks-section]')].map((row) => rowText(row).labelX),
      queueIcon: queue.icon,
      queueLabelX: queue.labelX,
      newsletterIcon: newsletter.icon,
      newsletterLabelX: newsletter.labelX,
    };
  });
}

function expectTasksLabelsShareTheNavColumn(indent) {
  expect(indent.labelsX).toHaveLength(5);
  for (const x of indent.labelsX) {
    // Tasks rows align with the other destinations, not with an extra inset.
    expect(Math.abs(x - indent.newsletterLabelX)).toBeLessThanOrEqual(2);
    expect(x).toBeGreaterThan(indent.newsletterIcon.right - 1);
    expect(x).toBeGreaterThan(indent.newsletterIcon.left + 8);
  }
  expect(Math.abs(indent.queueLabelX - indent.labelsX[0])).toBeLessThanOrEqual(2);
}

async function shotSidebar(page, name) {
  await page.locator('#sidebar').screenshot({
    path: path.join(screenshots, `${name}.png`),
    animations: 'disabled',
  });
}

test('first-class Tasks labels align with every other workspace destination', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);
  expectTasksLabelsShareTheNavColumn(await tasksLabelAlignment(page));
  await useTheme(page, false);
  await shotSidebar(page, 'desktop-1440-light');
  await useTheme(page, true);
  await shotSidebar(page, 'desktop-1440-dark');

  await page.locator('[data-tasks-section="queue"]').click();
  await expect(page).toHaveURL(/#\/tasks/);
  await expect(page.locator('[data-tasks-section="queue"]')).toHaveClass(/is-active/);
  await page.locator('[data-tasks-section="workflows"]').click();
  await expect(page).toHaveURL(/#\/cards/);
  await expect(page.locator('[data-tasks-section="workflows"]')).toHaveClass(/is-active/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open workspace' }).click();
  for (const section of TASK_SECTIONS) {
    await expect(page.locator(`[data-tasks-section="${section}"]`)).toBeVisible();
    expect((await page.locator(`[data-tasks-section="${section}"]`).boundingBox()).height)
      .toBeGreaterThanOrEqual(44);
  }
  expectTasksLabelsShareTheNavColumn(await tasksLabelAlignment(page));
  await useTheme(page, false);
  await shotSidebar(page, 'mobile-390-light');
  await useTheme(page, true);
  await shotSidebar(page, 'mobile-390-dark');
});
