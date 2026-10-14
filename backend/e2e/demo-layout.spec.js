const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { seedOperationsData } = require('./helpers/seed-operations-data');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
let server;
const routes = [
  ['/bookkeeping', '.bookkeeping-close-state h2'],
  ['/sponsors', '.crm-master .crm-booking-row, .crm-master .honest-state'],
  ['/tasks', '.ops-queue-list'], ['/cards', '.workflow-board-card'],
  ['/cards/archive', '.cards-archive-grid, .ops-honest-state'],
  ['/templates', '.runtime-template-inspector .dk-split'], ['/recurring', '.ops-recurring-section'],
  ['/calendar', '.calendar-grid'], ['/newsletter', '.newsletter-views'],
  ['/processes', '.ops-docs-catalog'],
  ['/operating-model', '.operating-model-grid, .review-empty-state'], ['/review', '.review-surface .dk-split, .review-empty-state'],
  ['/admin', '.ops-admin-card'], ['/users', '.ops-users-table'],
];
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('demo-layout', {
    'content/processes/sample.md': '---\ntitle: Sample process\ndoc_type: process\n---\n\n# Sample process\n\nSynthetic review fixture.\n',
  }) } });
  await seedOperationsData(server.baseURL);
});
test.afterAll(async () => stopOwnedTestServer(server));
for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
  test(`shared page headers and content align at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    // Fifteen routes in one test; the default 30s budget is too tight on a loaded runner.
    test.setTimeout(120000);
    await page.setViewportSize(viewport);
    await setupPageWithAuth(page);
    const out = path.resolve(__dirname, '../../.tmp/demo-b-after/layout');
    fs.mkdirSync(out, { recursive: true });
    let commonLeft;
    for (const [route, ready] of routes) {
      await page.goto(`${server.baseURL}${route}`);
      await expect(page.locator(ready).first()).toBeVisible();
      const header = page.locator('#document-list .dk-page-header').first();
      await expect(header.locator('h1')).toBeVisible();
      // Hydration can replace an already-visible header. Resolve and measure
      // both nodes from the current document in one browser evaluation.
      let geometry;
      await expect.poll(async () => {
        geometry = await page.evaluate(() => {
          const canvas = document.querySelector('#document-list');
          const heading = canvas?.querySelector('.dk-page-header h1');
          if (!heading?.getClientRects().length) return null;
          const a = canvas.getBoundingClientRect(), b = heading.getBoundingClientRect();
          return { canvas: { x: a.x, width: a.width }, heading: { x: b.x } };
        });
        return Boolean(geometry);
      }).toBe(true);
      const { canvas, heading } = geometry;
      const availableWidth = await page.locator('#library-view').evaluate((node) => {
        const style = getComputedStyle(node);
        return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
      expect(Math.abs(canvas.width - Math.min(1120, availableWidth)), `${route}: full page canvas width`).toBeLessThan(1);

      commonLeft ??= canvas.x;
      expect(Math.abs(canvas.x - commonLeft), `${route}: canvas left edge`).toBeLessThan(1);
      expect(Math.abs(heading.x - canvas.x), `${route}: title left edge`).toBeLessThan(1);
      expect(canvas.x + canvas.width).toBeLessThanOrEqual(viewport.width);
      if (route === '/newsletter') {
        // Add slot follows the view tabs it creates into.
        await expect(header.getByRole('button', { name: 'Add slot', exact: true })).toHaveCount(0);
        const actionButton = page.locator('.newsletter-toolbar').getByRole('button', { name: 'Add slot', exact: true });
        await expect(actionButton).toBeVisible();
        const action = await actionButton.boundingBox();
        const tabs = await page.locator('.newsletter-views').boundingBox();
        expect(action.y, `${route}: action shares or follows the tabs row`).toBeGreaterThanOrEqual(tabs.y - 1);
      }
      if (route === '/tasks') {
        const board = await page.locator('.ops-queue-board').boundingBox();
        expect(Math.abs(board.width - canvas.width)).toBeLessThan(1);
        // The queue's create actions follow its filters, above the rows.
        await expect(header.getByRole('button', { name: 'New task', exact: true })).toHaveCount(0);
        const toolbar = page.locator('.ops-queue-filters');
        await expect(toolbar.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
        await expect(toolbar.getByRole('button', { name: 'Create card', exact: true })).toBeVisible();
      }
      // Moved create actions sit on their collection, right after its title,
      // never in the page header's corner.
      const collectionAction = { '/users': 'Add user', '/bookkeeping': 'Add entry' }[route];
      if (collectionAction) {
        await expect(header.getByRole('button', { name: collectionAction, exact: true })).toHaveCount(0);
        const lead = page.locator('#document-list .collection-header__lead')
          .filter({ has: page.getByRole('button', { name: collectionAction, exact: true }) });
        await expect(lead).toHaveCount(1);
        const title = await lead.locator('h2, h3').first().boundingBox();
        const action = await lead.getByRole('button', { name: collectionAction, exact: true }).boundingBox();
        expect(action.x - (title.x + title.width), `${route}: action follows its collection title`).toBeLessThan(24);
      }
      if (route === '/calendar') {
        const grid = await page.locator('.calendar-grid').boundingBox();
        expect(Math.abs(grid.x - canvas.x)).toBeLessThan(1);
        expect(Math.abs(grid.width - canvas.width)).toBeLessThan(1);
        // Add activity rides on the calendar toolbar, not the page corner.
        await expect(header.getByRole('button', { name: 'Add activity', exact: true })).toHaveCount(0);
        await expect(page.locator('.calendar-controls').getByRole('button', { name: 'Add activity', exact: true })).toBeVisible();
      }
      if (route === '/sponsors') {
        // Add deal follows the list title it creates into.
        await expect(header.getByRole('button')).toHaveCount(0);
        const lead = page.locator('.crm-list-head .collection-header__lead');
        const title = await lead.locator('h2').boundingBox();
        const action = await lead.getByRole('button', { name: 'Add deal', exact: true }).boundingBox();
        expect(action.x - (title.x + title.width), `${route}: action follows its collection title`).toBeLessThan(24);
      }
      await page.screenshot({ path: path.join(out, `${route.slice(1).replaceAll('/', '-')}-${viewport.width}x${viewport.height}.png`) });
    }
  });
}
