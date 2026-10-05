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
const TASK_SECTIONS = ['queue', 'workflows', 'templates', 'recurring', 'assistants', 'artifacts'];
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
  assertOwnedServerResponse(server, response, 'issue-245 home');
  await expect(page.locator('.operations-home[data-operations-work-loaded="true"]')).toBeVisible();
}

async function expandTasks(page) {
  const toggle = page.locator('#tasks-nav-button');
  if (await toggle.getAttribute('aria-expanded') !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  for (const section of TASK_SECTIONS) {
    await expect(page.locator(`[data-tasks-section="${section}"]`)).toBeVisible();
  }
}

async function nestedTasksLabelAlignment(page) {
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

    const parentLabel = document.querySelector('#operations-home-button span:not(.workspace-nav-icon)');
    const parentIcon = document.querySelector('#operations-home-button .workspace-nav-icon').getBoundingClientRect();
    return {
      parentX: textLeft(parentLabel),
      iconLeft: parentIcon.left,
      iconRight: parentIcon.right,
      nestedXs: [...document.querySelectorAll('#tasks-nav-submenu .workspace-subnav-button')].map(textLeft),
    };
  });
}

function expectNestedLabelsAlignWithParentText(indent) {
  expect(indent.nestedXs).toHaveLength(6);
  for (const x of indent.nestedXs) {
    expect(Math.abs(x - indent.parentX)).toBeLessThanOrEqual(2);
    expect(x).toBeGreaterThan(indent.iconRight - 1);
    expect(x).toBeGreaterThan(indent.iconLeft + 8);
  }
}

async function shotSidebar(page, name) {
  await page.locator('#sidebar').screenshot({
    path: path.join(screenshots, `${name}.png`),
    animations: 'disabled',
  });
}

test('nested Tasks labels align with parent Daily work labels', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);
  await expandTasks(page);
  expectNestedLabelsAlignWithParentText(await nestedTasksLabelAlignment(page));
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
  await expandTasks(page);
  for (const section of TASK_SECTIONS) {
    expect((await page.locator(`[data-tasks-section="${section}"]`).boundingBox()).height)
      .toBeGreaterThanOrEqual(44);
  }
  expectNestedLabelsAlignWithParentText(await nestedTasksLabelAlignment(page));
  await useTheme(page, false);
  await shotSidebar(page, 'mobile-390-light');
  await useTheme(page, true);
  await shotSidebar(page, 'mobile-390-dark');
});
