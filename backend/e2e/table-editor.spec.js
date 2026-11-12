// Notion-style table editing in the document editor: click a cell and type,
// move with Tab / Shift+Tab / Enter / arrows, add, move and delete rows and
// columns, keep links and formatting, and save a plain markdown table that
// reads back the same after a reload. The docs API is an in-memory fake;
// the content is synthetic.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots', 'table-editor');
const DOC_PATH = 'content/testing/table-doc.md';
const TABLE = [
  '| Step | Owner | Notes |',
  '| --- | --- | --- |',
  '| transcript | Reviewer | See [the guide](https://example.com/guide) and **bold** |',
  '| audio | Producer | Plain |',
].join('\n');
const CONTENT = `# Synthetic table doc\n\nIntro paragraph.\n\n${TABLE}\n\nClosing paragraph.\n`;

let server;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('table-editor', { [DOC_PATH]: CONTENT }) },
  });
});
test.afterAll(async () => stopOwnedTestServer(server));

async function openDoc(page, viewport = { width: 1440, height: 900 }) {
  const state = { revision: 'r1', content: CONTENT, saves: [] };
  await page.setViewportSize(viewport);
  await setupPageWithAuth(page);
  // Reads come from the real server until a save; then the saved bytes.
  await page.route('**/docs?**', async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      state.saves.push(req.postDataJSON());
      state.content = req.postDataJSON().content;
      state.revision = `r${state.saves.length + 1}`;
      return route.fulfill({ json: { updated: 2, revision: state.revision } });
    }
    const url = new URL(req.url());
    if (state.saves.length && url.searchParams.get('path') === DOC_PATH) {
      return route.fulfill({ json: { path: DOC_PATH, content: state.content, revision: state.revision, updated: 1 } });
    }
    return route.continue();
  });
  await page.goto(`${server.baseURL}/testing/table-doc.md`);
  await expect(page.locator('#rendered-view .notion-table')).toBeVisible({ timeout: 20_000 });
  return state;
}

const draft = (page) => page.locator('#editor');
const cell = (page, row, column) => page.locator(`.notion-table-cell[data-row="${row}"][data-col="${column}"]`);
async function capture(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}

test('a markdown table renders as an editable grid with working links and no mid-word breaks', async ({ page }) => {
  await openDoc(page, { width: 700, height: 900 });
  await expect(page.locator('.notion-table-cell')).toHaveCount(9);
  await expect(cell(page, -1, 0)).toHaveText('Step');
  await expect(cell(page, 0, 2).locator('a')).toHaveAttribute('data-href', 'https://example.com/guide');
  await expect(cell(page, 0, 2).locator('strong')).toHaveText('bold');
  // Every word of the narrow first column sits whole on one line.
  const broken = await page.evaluate(() => [...document.querySelectorAll('.notion-table-cell')].filter((el) => {
    const range = document.createRange();
    return el.textContent.split(/\s+/).filter(Boolean).some((word) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.nodeValue.indexOf(word);
        if (at < 0) continue;
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        return range.getClientRects().length > 1 && new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1;
      }
      return false;
    });
  }).map((el) => el.textContent));
  expect(broken).toEqual([]);
  await capture(page, 'table-narrow');
});

test('click a cell and type; Tab, Shift+Tab, Enter and arrows move between cells', async ({ page }) => {
  await openDoc(page);
  await cell(page, 1, 0).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' track');
  await expect(draft(page)).toHaveValue(/\| audio track \| Producer \| Plain \|/);
  await page.keyboard.press('Tab');
  await expect(cell(page, 1, 1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cell(page, 1, 2)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cell(page, 1, 1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(cell(page, 0, 1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(cell(page, 1, 1)).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowLeft');
  await expect(cell(page, 1, 0)).toBeFocused();
  // Enter goes to the cell below; in the last row it adds a row.
  await page.keyboard.press('Enter');
  await expect(cell(page, 2, 0)).toBeFocused();
  await page.keyboard.type('new');
  await expect(draft(page)).toHaveValue(/\| audio track \| Producer \| Plain \|\n\| new \|  \|  \|/);
  // Tab from the last cell adds a row too.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(cell(page, 3, 0)).toBeFocused();
  await expect(page.locator('.notion-table tbody tr')).toHaveCount(4);
  await capture(page, 'table-keyboard');
});

test('rows and columns are added, moved and deleted from their handles', async ({ page }) => {
  await openDoc(page);
  const menu = page.locator('.block-menu');
  await page.locator('.notion-table-row-grip').nth(1).click({ force: true });
  await menu.getByRole('menuitem', { name: 'Insert row below' }).click();
  await expect(page.locator('.notion-table tbody tr')).toHaveCount(3);
  await expect(cell(page, 1, 0)).toBeFocused();
  await page.keyboard.type('middle');
  await expect(draft(page)).toHaveValue(/\| transcript \|[^\n]*\n\| middle \|  \|  \|\n\| audio \|/);

  await page.locator('.notion-table-row-grip').nth(2).click({ force: true });
  await menu.getByRole('menuitem', { name: 'Move row up' }).click();
  await expect(draft(page)).toHaveValue(/\| middle \|[^\n]*\n\| transcript \|/);

  await page.locator('.notion-table-row-grip').nth(1).click({ force: true });
  await menu.getByRole('menuitem', { name: 'Delete row' }).click();
  await expect(page.locator('.notion-table tbody tr')).toHaveCount(2);
  await expect(draft(page)).not.toHaveValue(/\| middle \|/);

  await page.locator('.notion-table-column-grip').nth(1).click({ force: true });
  await menu.getByRole('menuitem', { name: 'Insert column right' }).click();
  await expect(cell(page, -1, 2)).toBeFocused();
  await page.keyboard.type('Status');
  await expect(draft(page)).toHaveValue(/\| Step \| Owner \| Status \| Notes \|\n\| --- \| --- \| --- \| --- \|/);

  await page.locator('.notion-table-column-grip').nth(0).click({ force: true });
  await menu.getByRole('menuitem', { name: 'Move column right' }).click();
  await expect(draft(page)).toHaveValue(/\| Owner \| Step \| Status \| Notes \|/);

  await page.locator('.notion-table-column-grip').nth(2).click({ force: true });
  await menu.getByRole('menuitem', { name: 'Delete column' }).click();
  await expect(draft(page)).toHaveValue(/\| Owner \| Step \| Notes \|\n\| --- \| --- \| --- \|\n\| Reviewer \| transcript \|/);

  // The "+" strips append a row and a column.
  await page.locator('.notion-table-add-row').click({ force: true });
  await expect(page.locator('.notion-table tbody tr')).toHaveCount(3);
  await page.locator('.notion-table-add-column').click({ force: true });
  await expect(cell(page, -1, 3)).toBeFocused();
  await capture(page, 'table-structure');
});

test('a row drags to a new place', async ({ page }) => {
  await openDoc(page);
  await page.locator('.notion-table tbody tr').first().hover();
  await page.locator('.notion-table-row-grip').nth(1).dragTo(cell(page, 1, 1), { targetPosition: { x: 20, y: 24 } });
  await expect(draft(page)).toHaveValue(/\| audio \|[^\n]*\n\| transcript \|/);
});

test('save writes a plain markdown table that survives a reload', async ({ page }) => {
  const state = await openDoc(page);
  await cell(page, 1, 1).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' | Lead');
  await cell(page, 0, 0).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (v2)');
  await page.keyboard.press('Escape');
  await page.locator('#editor-save-button').click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = state.saves[0].content;
  expect(saved).toContain('| audio | Producer \\| Lead | Plain |');
  expect(saved).toContain('[the guide](https://example.com/guide)');
  expect(saved).toContain('**bold**');
  expect(saved).toContain('Intro paragraph.\n\n| Step | Owner | Notes |\n| --- | --- | --- |\n| transcript (v2) |');
  expect(saved).toContain('\n\nClosing paragraph.');
  await page.reload();
  await expect(page.locator('#rendered-view .notion-table')).toBeVisible({ timeout: 20_000 });
  await expect(cell(page, 1, 1)).toHaveText('Producer | Lead');
  await expect(cell(page, 0, 2).locator('a')).toHaveText('the guide');
  await expect(page.locator('.notion-table tbody tr')).toHaveCount(2);
  await capture(page, 'table-reloaded');
});

test('an untouched table is written back byte for byte', async ({ page }) => {
  const state = await openDoc(page);
  await page.locator('.notion-block-paragraph .notion-text-content', { hasText: 'Closing paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More.');
  await page.keyboard.press('Escape');
  await page.locator('#editor-save-button').click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0].content).toContain(`${TABLE}\n\nClosing paragraph. More.`);
});
