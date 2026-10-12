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
  test(`Compose: slash menu inserts Sponsor Spotlight at ${width}px`, async ({ page }) => {
    const root = await openEditor(page, 'Compose', { width, height: width === 1440 ? 900 : 800 });
    await root.locator('.notion-add-row-btn').click();
    await page.locator('.slash-menu-filter').fill('sponsor spotlight');
    await page.getByRole('menuitem').filter({ hasText: 'Sponsor Spotlight' }).click();
    const spotlight = root.locator('.notion-callout-important');
    await expect(spotlight.locator('.inline-editor')).toBeFocused();
    await expect(spotlight.locator('.inline-editor')).toHaveValue(/PARTNER SPOTLIGHT/);
    await root.locator('.notion-list-item-text').first().click();
    await expect(spotlight).toContainText('PARTNER SPOTLIGHT');
    await page.getByRole('button', { name: 'Email Preview', exact: true }).click();
    await expect(page.locator('[data-sim-body]')).toContainText('PARTNER SPOTLIGHT');
  });

  for (const surface of ['Docs', 'Compose']) {
    test(`${surface}: slash choices focus editable headings and to-dos at ${width}px`, async ({ page }) => {
      const root = await openEditor(page, surface, { width, height: width === 1440 ? 900 : 800 });
      for (const choice of [
        { query: 'h2', label: 'Heading 2', type: 'h2', text: 'Typed heading', raw: /## Typed heading/ },
        { query: 'to-do', label: 'To-do List', type: 'todo', text: 'Typed task', raw: /- \[ \] Typed task/ },
      ]) {
        await root.locator('.notion-add-row-btn').click();
        await page.locator('.slash-menu-filter').fill(choice.query);
        await page.getByRole('menuitem').filter({ hasText: choice.label }).click();
        const block = root.locator(`[data-block-type="${choice.type}"]`).last();
        const input = block.locator('.inline-editor');
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('');
        if (choice.type === 'todo') await expect(block.locator('.notion-todo-checkbox')).not.toBeChecked();
        await page.keyboard.type(choice.text);
        await expect(input).toHaveValue(choice.text);
        await root.locator('.notion-list-item-text').first().click();
        await expect(block).toContainText(choice.text);
        await expect(block).not.toContainText(choice.label);
        if (surface === 'Docs') await expect(page.locator('#editor')).toHaveValue(choice.raw);
      }
    });

    test(`${surface}: typing slash converts a paragraph and focuses the replacement at ${width}px`, async ({ page }) => {
      const root = await openEditor(page, surface, { width, height: width === 1440 ? 900 : 800 });
      await root.locator('.notion-text-content.paragraph').last().click();
      const input = root.locator('.notion-text-content.paragraph .inline-editor').last();
      await input.fill('');
      await input.press('/');
      await page.locator('.slash-menu-filter').fill('h2');
      await page.locator('.slash-menu-filter').press('Enter');
      const heading = root.locator('[data-block-type="h2"] .inline-editor').last();
      await expect(heading).toBeFocused();
      await expect(heading).toHaveValue('');
      await page.keyboard.type('Replacement heading');
      await root.locator('.notion-list-item-text').first().click();
      await expect(root.locator('[data-block-type="h2"]')).toContainText('Replacement heading');
      if (surface === 'Docs') await expect(page.locator('#editor')).toHaveValue(/## Replacement heading/);
    });

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
