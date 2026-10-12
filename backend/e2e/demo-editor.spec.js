const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

let server;
const content = '# Synthetic editor\n\n1. First item\n2. Second item\n\nBody text.';
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: {
    DTC_CACHE_ROOT: createDocsCacheRoot('demo-editor'),
  } });
});
test.afterAll(async () => stopOwnedTestServer(server));

async function openEditor(page, surface, viewport) {
  await page.setViewportSize(viewport);
  await setupPageWithAuth(page);
  await page.route('**/docs**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/docs') return route.fulfill({ json: {} });
    return route.fulfill({ json: url.searchParams.has('path') ? {
      path: 'content/testing/editor.md', content, revision: 'r1',
      parsed: { frontmatter: { title: 'Synthetic editor' }, sections: [] },
    } : { documents: [{ path: 'content/testing/editor.md', title: 'Synthetic editor' }] } });
  });
  await page.route('**/work/api/newsletter-slots**', (route) => route.fulfill({ json: {
    items: [{ id: 'synthetic-editor-slot', publicationDate: '2026-10-12',
      campaignLabel: 'Synthetic editor', status: 'draft', version: 1,
      planningNote: content }], alerts: [],
  } }));
  if (surface === 'Docs') {
    await page.goto(`${server.baseURL}/testing/editor.md`);
    await expect(page.locator('#rendered-view .notion-list')).toBeVisible();
    return page.locator('#rendered-view');
  }
  await page.goto(`${server.baseURL}/#/newsletter`);
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.locator('dialog [data-blocks-editor] .notion-list')).toBeVisible();
  return page.locator('dialog [data-blocks-editor]');
}

for (const width of [1440, 1280]) {
  for (const surface of ['Docs', 'Compose']) {
    test(`${surface}: Enter focuses the new list item at ${width}px`, async ({ page }) => {
      const root = await openEditor(page, surface, { width, height: width === 1440 ? 900 : 800 });
      await root.locator('.notion-list-item-text').first().click();
      await page.keyboard.press('Enter');
      const next = root.locator('.notion-list-item-text').nth(1).locator('.inline-editor');
      await expect(next).toBeFocused();
      await expect(next).toHaveValue('');
      await page.keyboard.type('Typed immediately after Enter');
      await expect(next).toHaveValue('Typed immediately after Enter');
      await root.locator('.notion-text-content').last().click();
      await expect(root.locator('.notion-list-item-text').nth(1)).toHaveText('Typed immediately after Enter');
      if (surface === 'Docs') {
        await expect(page.locator('#editor')).toHaveValue(/2\. Typed immediately after Enter/);
      }
    });
  }
}
