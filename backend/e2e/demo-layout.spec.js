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
  ['/templates', '.runtime-template-layout'], ['/recurring', '.ops-recurring-section'],
  ['/calendar', '.calendar-grid'], ['/newsletter', '.newsletter-views'],
  ['/assistants', '.assistant-layout'], ['/processes', '.ops-docs-catalog'],
  ['/operating-model', '.operating-model-grid, .review-empty-state'], ['/review', '.review-summary'],
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
        const actionButton = header.getByRole('button', { name: 'Add slot', exact: true });
        await expect(actionButton).toBeVisible();
        const action = await actionButton.boundingBox();
        expect(Math.abs(action.x + action.width - canvas.x - canvas.width), `${route}: action right edge`).toBeLessThan(1);
      }
      if (route === '/tasks') {
        const board = await page.locator('.ops-queue-board').boundingBox();
        expect(Math.abs(board.width - canvas.width)).toBeLessThan(1);
        const actionButton = header.getByRole('button', { name: 'Create card', exact: true });
        await expect(actionButton).toBeVisible();
        const action = await actionButton.boundingBox();
        expect(Math.abs(action.x + action.width - canvas.x - canvas.width)).toBeLessThan(1);
      }
      if (route === '/users') {
        const actionButton = header.getByRole('button', { name: 'Add user', exact: true });
        await expect(actionButton).toBeVisible();
        const action = await actionButton.boundingBox();
        expect(Math.abs(action.x + action.width - canvas.x - canvas.width)).toBeLessThan(1);
      }
      if (route === '/calendar') {
        const grid = await page.locator('.calendar-grid').boundingBox();
        expect(Math.abs(grid.x - canvas.x)).toBeLessThan(1);
        expect(Math.abs(grid.width - canvas.width)).toBeLessThan(1);
        const action = await header.getByRole('button', { name: 'Add activity', exact: true }).boundingBox();
        expect(Math.abs(action.x + action.width - canvas.x - canvas.width)).toBeLessThan(1);
      }
      const financeAction = { '/bookkeeping': 'Add entry', '/sponsors': 'Add deal' }[route];
      if (financeAction) {
        const action = await header.getByRole('button', { name: financeAction, exact: true }).boundingBox();
        expect(Math.abs(action.x + action.width - canvas.x - canvas.width), `${route}: action right edge`).toBeLessThan(1);
      }
      await page.screenshot({ path: path.join(out, `${route.slice(1).replaceAll('/', '-')}-${viewport.width}x${viewport.height}.png`) });
    }
  });
}
