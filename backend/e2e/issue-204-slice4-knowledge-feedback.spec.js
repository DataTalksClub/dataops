// Issue 204 slice 4: Knowledge owning surfaces report catalog, search, and
// single-document feedback where the operator is already working.
//
// Fixtures are synthetic and public-safe. Faults are installed on the owned
// test server, so the browser still exercises the real frontend and HTTP
// routes without request interception.
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

const SCREENSHOT_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '.tmp',
  'screenshots',
  'issue-204',
  'slice-04',
);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const ALPHA_PATH = 'content/operations/slice4-alpha.md';
const BETA_PATH = 'content/product/slice4-beta.md';
const ALPHA_DOC = [
  '---',
  'id: process.synthetic.slice4-alpha',
  'title: Synthetic Slice Four Alpha',
  'summary: Public-safe Process Docs fixture for loading and filtering.',
  'doc_type: sop',
  'domain: operations',
  'systems: [dataops]',
  'tags: [slice-four, operations]',
  '---',
  '',
  '# Synthetic Slice Four Alpha',
  '',
  'A public-safe process fixture for the owning-surface browser contract.',
  '',
].join('\n');
const BETA_DOC = [
  '---',
  'id: reference.synthetic.slice4-beta',
  'title: Synthetic Slice Four Beta',
  'summary: Public-safe reference fixture for filter-empty feedback.',
  'doc_type: reference',
  'domain: product',
  'systems: [docs]',
  'tags: [slice-four, product]',
  '---',
  '',
  '# Synthetic Slice Four Beta',
  '',
  'A second public-safe fixture used to make a valid filter combination empty.',
  '',
].join('\n');

let server;
let emptyServer;

async function ownedContext(browser, options = {}, targetServer = server) {
  const context = await browser.newContext({
    baseURL: targetServer.baseURL,
    ...options,
  });
  const health = await context.request.get('/api/health');
  assertOwnedServerResponse(targetServer, health, 'issue 204 slice 4 health');
  return context;
}

async function setFaults(request, faults) {
  const response = await request.post('/__e2e__/route-faults', {
    data: { faults },
  });
  expect(response.ok()).toBe(true);
}

async function clearFaults(request) {
  const response = await request.delete('/__e2e__/route-faults');
  expect(response.ok()).toBe(true);
}

async function screenshot(page, name) {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    animations: 'disabled',
  });
}

async function expectNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.documentScrollWidth, JSON.stringify(metrics))
    .toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics))
    .toBeLessThanOrEqual(metrics.viewportWidth);
}

async function navigateToDocument(page, visiblePath) {
  await page.evaluate((path) => {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, visiblePath);
}

async function openDocumentFilters(page) {
  const filters = page.locator('#filters-section');
  if (!(await filters.evaluate((element) => element.open))) {
    await filters.locator('summary').click();
  }
}

async function chooseDocumentFilter(page, index, label) {
  const filter = page.locator('#filter-row .custom-select').nth(index);
  await filter.getByRole('button').click();
  await filter.getByRole('option', { name: label, exact: true }).click();
}

test.describe('issue 204 slice 4 Knowledge feedback', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot('issue-204-slice-4-knowledge', {
          [ALPHA_PATH]: ALPHA_DOC,
          [BETA_PATH]: BETA_DOC,
        }),
      },
    });
    emptyServer = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot('issue-204-slice-4-knowledge-empty'),
      },
    });
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(emptyServer);
    await stopOwnedTestServer(server);
  });

  test('shows catalog, search, and document feedback across desktop and mobile', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);

    // Process Docs owns the visible catalog loading state while independent
    // work requests continue in the background.
    await setFaults(context.request, [
      { method: 'GET', path: '/docs', delayMs: 1200 },
    ]);
    await page.goto('/#/processes');
    const catalogLoading = page.locator(
      '.ops-surface-docs [data-docs-state="loading"]',
    );
    await expect(catalogLoading).toBeVisible();
    await expect(catalogLoading).toContainText('Work, Cards, and Tasks remain independent');
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'process-docs-loading-desktop-1440x900');

    await expect(
      page.locator('#domain-filter option[value="operations"]'),
    ).toHaveCount(1, { timeout: 20_000 });
    await openDocumentFilters(page);
    await chooseDocumentFilter(page, 0, 'Operations');
    await chooseDocumentFilter(page, 3, 'Product');
    await expect(page).toHaveURL(/\/\#\/processes\?domain=operations&tag=product$/);
    const filterEmpty = page.locator(
      '.ops-surface-docs [data-docs-state="filter-empty"]',
    );
    await expect(filterEmpty).toBeVisible();
    await expect(filterEmpty).toContainText('catalog contains 2 process documents');
    await expect(page.locator('#filter-count')).toHaveText('2');

    await page.setViewportSize(MOBILE);
    await page.locator('#mobile-menu-button').click();
    await expect(page.locator('body')).toHaveClass(/sidebar-open/);
    await openDocumentFilters(page);
    await expect(page.locator('#clear-filters-button')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'process-docs-filter-controls-mobile-390x844');
    await page.locator('#sidebar-close-button').click();
    await expect(page.locator('body')).not.toHaveClass(/sidebar-open/);
    await expect(filterEmpty).toBeVisible();
    await screenshot(page, 'process-docs-filter-empty-mobile-390x844');

    await clearFaults(context.request);
    await page.setViewportSize(DESKTOP);
    await page.goto('/#/processes');
    await expect(page.locator('.ops-surface-docs')).toBeVisible();
    await expect(
      page.locator('.ops-surface-docs [data-docs-state]'),
    ).toHaveCount(0);
    await expect(page.locator('#tag-filter option[value="slice-four"]')).toHaveCount(1);
    await screenshot(page, 'process-docs-healthy-loaded-desktop-1440x900');

    // A separate synthetic cache proves an answered empty corpus is not
    // confused with loading or unavailable Process Docs.
    const emptyContext = await ownedContext(browser, { viewport: DESKTOP }, emptyServer);
    const emptyPage = await emptyContext.newPage();
    await setupPageWithAuth(emptyPage);
    await emptyPage.goto('/#/processes');
    const answeredEmpty = emptyPage.locator(
      '.ops-surface-docs [data-docs-state="empty"]',
    );
    await expect(answeredEmpty).toBeVisible({ timeout: 20_000 });
    await expect(answeredEmpty).toContainText('No process documents yet');
    await expect(emptyPage.locator('.ops-surface-docs [data-docs-state="loading"]')).toHaveCount(0);
    await expect(emptyPage.locator('.ops-surface-docs [data-docs-state="unavailable"]')).toHaveCount(0);
    await expectNoHorizontalOverflow(emptyPage);
    await screenshot(emptyPage, 'process-docs-answered-empty-desktop-1440x900');
    await emptyPage.setViewportSize(MOBILE);
    await emptyPage.goto('/#/processes');
    await expect(emptyPage.locator('.ops-surface-docs [data-docs-state="empty"]')).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(emptyPage);
    await screenshot(emptyPage, 'process-docs-answered-empty-mobile-390x844');
    await emptyContext.close();

    // Search keeps successful Process Docs results visible while naming the
    // failed work source and offering a same-query retry.
    await setFaults(context.request, [
      { method: 'GET', path: '/api/artifacts', status: 503 },
    ]);
    await page.locator('#search-input').fill('slice four');
    const partial = page.locator(
      '.search-source-state[data-search-state="partial"]',
    );
    await expect(partial).toBeVisible({ timeout: 20_000 });
    await expect(partial).toContainText('artifacts');
    await expect(
      page.locator('.unified-search-group').filter({ hasText: 'Process Docs' }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'search-partial-desktop-1440x900');

    await clearFaults(context.request);
    await setFaults(context.request, [
      { method: 'GET', path: '/search', status: 503 },
      { method: 'GET', path: '/api/tasks', status: 503 },
      { method: 'GET', path: '/api/cards', status: 503 },
      { method: 'GET', path: '/api/templates', status: 503 },
      { method: 'GET', path: '/api/artifacts', status: 503 },
      { method: 'GET', path: '/api/assistant-jobs', status: 503 },
    ]);
    await page.locator('#search-input').fill('slice four');
    const unavailableSearch = page.locator(
      '.search-source-state[data-search-state="unavailable"]',
    );
    await expect(unavailableSearch).toBeVisible({ timeout: 20_000 });
    await expect(unavailableSearch.locator('li')).toHaveCount(6);
    for (const source of [
      'process documents',
      'tasks',
      'workflows',
      'templates',
      'artifacts',
      'assistant-jobs',
    ]) {
      await expect(unavailableSearch).toContainText(source);
    }
    await page.setViewportSize(MOBILE);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'search-unavailable-mobile-390x844');

    await clearFaults(context.request);
    await unavailableSearch.getByRole('button', { name: /Retry search/ }).click();
    await expect(
      page.locator('.unified-search-group').filter({ hasText: 'Process Docs' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#search-input')).toHaveValue('slice four');

    // A healthy-catalog 404 is visibly different from a corpus outage.
    await page.setViewportSize(DESKTOP);
    await navigateToDocument(page, '/synthetic/missing.md');
    const notFound = page.locator(
      '#doc-state [data-document-state="not-found"]',
    );
    await expect(notFound).toBeVisible({ timeout: 20_000 });
    await expect(notFound).toContainText('Document not found');
    await expect(page).toHaveURL(`${server.baseURL}/synthetic/missing.md`);
    await expect(page.locator('#editor')).toBeDisabled();
    await expect(page.locator('#document-title')).toBeDisabled();
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'document-not-found-desktop-1440x900');

    // A direct single-document 503 stays local to the editor and still leaves
    // it disabled until the document itself succeeds.
    await setFaults(context.request, [
      {
        method: 'GET',
        path: '/docs',
        query: { path: ALPHA_PATH },
        status: 503,
      },
    ]);
    await navigateToDocument(page, '/operations/slice4-alpha.md');
    const documentUnavailable = page.locator(
      '#doc-state [data-document-state="unavailable"]',
    );
    await expect(documentUnavailable).toBeVisible({ timeout: 20_000 });
    await expect(documentUnavailable).toContainText('Synthetic route failure (503)');
    await expect(page.locator('#editor')).toBeDisabled();
    await expect(page.locator('#document-title')).toBeDisabled();
    await page.setViewportSize(MOBILE);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, 'document-unavailable-mobile-390x844');

    await clearFaults(context.request);
    const retryDocument = page.locator('#doc-state button.surface-summary-retry');
    await expect(retryDocument).toBeVisible();
    await retryDocument.click();
    await expect(page.locator('#doc-state')).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('#editor')).toBeEnabled();
    await page.setViewportSize(DESKTOP);
    await page.goto('/#/processes');
    await expect(page.locator('.ops-surface-docs [data-docs-state]')).toHaveCount(0);
    await navigateToDocument(page, '/synthetic/missing.md');
    await expect(
      page.locator('#doc-state [data-document-state="not-found"]'),
    ).toBeVisible({ timeout: 20_000 });
    await context.close();
  });
});
