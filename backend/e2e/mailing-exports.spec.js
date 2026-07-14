const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

test.setTimeout(120_000);
const screenshots = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots', 'issue-108-engineer-retest');
const syntheticConfig = { id: 'synthetic-mailchimp', provider: 'mailchimp', account: 'Synthetic account', scopeLabel: 'All audiences (account export)', enabled: true };
const todayRunKey = new Date().toISOString().slice(0, 10);
const viewports = [{ label: 'desktop', width: 1280, height: 900 }, { label: 'mobile-390', width: 390, height: 844 }];
const categories = [
  ['authorization', 'fix-authorization'], ['provider-api', 'retry'], ['provider-timeout', 'retry'],
  ['provider-concurrency', 'wait'], ['download-integrity', 'retry'], ['storage', 'fix-storage'],
  ['persistence', 'retry'], ['task-link', 'fix-task-link'],
];
const servers = [];

function serve(root, files) {
  const server = http.createServer((request, response) => {
    const file = files[new URL(request.url, 'http://local').pathname];
    if (!file) return response.writeHead(404).end();
    const absolute = path.join(root, file);
    response.setHeader('content-type', absolute.endsWith('.js') ? 'text/javascript' : absolute.endsWith('.css') ? 'text/css' : 'text/html');
    fs.createReadStream(absolute).pipe(response);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    servers.push(server);
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}

let fallbackBase, productionBase;
test.beforeAll(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  fallbackBase = await serve(path.resolve(__dirname, '..', 'src'), {
    '/': 'pages/index.html', '/public/app.js': 'public/app.js', '/public/api.js': 'public/api.js',
  });
  productionBase = await serve(path.resolve(__dirname, '..', '..', 'frontend'), {
    '/': 'index.html', '/src/app.js': 'src/app.js', '/src/styles.css': 'src/styles.css',
  });
});
test.afterAll(() => servers.forEach(server => server.close()));

const surfaces = [
  { label: 'fallback', base: () => fallbackBase, locator: '#app', open: page => page.goto(`${fallbackBase}/#/mailing-exports`) },
  { label: 'production', base: () => productionBase, locator: '.mailing-exports-surface', open: async page => {
    await page.goto(productionBase);
    const navigation = page.getByRole('button', { name: 'Mailing exports' });
    if (!(await navigation.isVisible())) {
      await page.getByRole('button', { name: 'Open workspace' }).click();
    }
    await navigation.click();
  } },
];

async function newPage(browser, surface, viewport, list, onRun) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('dataops_token', 'synthetic-token');
    localStorage.setItem('dataops_user', JSON.stringify({ id: 'synthetic-operator', name: 'Synthetic operator' }));
  });
  await page.route('**/docs', route => route.fulfill({ json: { documents: [] } }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/me') return route.fulfill({ json: { user: { id: 'synthetic-operator' } } });
    if (url.pathname.endsWith('/api/mailing-exports') && request.method() === 'GET') {
      const payload = typeof list === 'function' ? await list() : list;
      return route.fulfill(payload instanceof Error ? { status: 503, json: { error: payload.message } } : { json: payload });
    }
    if (url.pathname.endsWith('/api/mailing-exports/run') && request.method() === 'POST') {
      return onRun ? onRun(route) : route.fulfill({ status: 202, json: { export: { status: 'pending' } } });
    }
    if (/\/api\/artifacts\/[^/]+\/download$/.test(url.pathname)) {
      return route.fulfill({ json: { downloadUrl: `${surface.base()}/#synthetic-download`, expiresIn: 300 } });
    }
    return route.fulfill({ json: { items: [], results: [], sources: [] } });
  });
  await surface.open(page);
  if (viewport.width === 390 && surface.label === 'production') {
    await expect(page.locator('#sidebar')).not.toBeInViewport();
  }
  return { context, page, root: page.locator(surface.locator) };
}

function assertNoOverflow(page, width) {
  return expect.poll(async () => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(width);
}

for (const surface of surfaces) {
  test(`${surface.label} portal covers loading, empty, pending/manual, completed/download and errors at desktop and 390px`, async ({ browser }) => {
    for (const viewport of viewports) {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const loading = await newPage(browser, surface, viewport, async () => { await gate; return { configs: [], exports: [] }; });
      await expect(loading.page.getByRole('status')).toContainText('Loading export configurations');
      await loading.page.screenshot({ path: path.join(screenshots, `${surface.label}-${viewport.label}-loading.png`), fullPage: true });
      release();
      await expect(loading.page.locator('[data-export-state="no-config"]')).toBeVisible();
      await expect(loading.page.locator('[data-export-state="empty"]')).toBeVisible();
      await assertNoOverflow(loading.page, viewport.width);
      await loading.page.screenshot({ path: path.join(screenshots, `${surface.label}-${viewport.label}-empty.png`), fullPage: true });
      await loading.context.close();

      let runState = 'empty', postCount = 0;
      const pendingSubmittedKeys = [];
      const pendingPayload = () => ({
        configs: [syntheticConfig],
        exports: runState === 'pending' ? [{ id: 'run-pending', configId: syntheticConfig.id, provider: 'mailchimp', account: syntheticConfig.account, scopeLabel: syntheticConfig.scopeLabel, runKey: '2026-07-14', status: 'pending', requestedAt: '2026-07-14T09:00:00Z', updatedAt: '2026-07-14T09:01:00Z', createdAt: '2026-07-14T09:00:00Z', nextAction: 'wait', taskId: 'synthetic-task' }] : [],
      });
      const pending = await newPage(browser, surface, viewport, pendingPayload, async route => {
        postCount++; pendingSubmittedKeys.push(route.request().postDataJSON().runKey); runState = 'pending'; await new Promise(resolve => setTimeout(resolve, 60));
        return route.fulfill({ status: 202, json: { export: { status: 'pending' } } });
      });
      const start = pending.page.getByRole('button', { name: 'Start daily export' });
      await start.focus(); await pending.page.keyboard.press('Enter');
      await expect(start).toBeDisabled();
      await expect(pending.page.locator('[data-export-state="pending"]')).toBeVisible();
      expect(postCount).toBe(1);
      expect(pendingSubmittedKeys).toEqual([todayRunKey]);
      await expect(pending.page.getByText(/Wait for the provider/)).toBeVisible();
      const advance = pending.page.getByRole('button', { name: 'Advance / retry' });
      await advance.focus(); await pending.page.keyboard.press('Enter');
      await expect(advance).toBeDisabled();
      await expect.poll(() => postCount).toBe(2);
      expect(pendingSubmittedKeys).toEqual([todayRunKey, '2026-07-14']);
      await assertNoOverflow(pending.page, viewport.width);
      await pending.page.screenshot({ path: path.join(screenshots, `${surface.label}-${viewport.label}-pending.png`), fullPage: true });
      await pending.context.close();

      let completedState = 'completed', completedPosts = 0, completedSubmittedKey;
      const completedPayload = () => ({
        configs: [syntheticConfig],
        exports: completedState === 'completed'
          ? [{ id: 'run-complete', configId: syntheticConfig.id, provider: 'mailchimp', account: syntheticConfig.account, scopeLabel: syntheticConfig.scopeLabel, runKey: '2026-07-13', status: 'completed', requestedAt: '2026-07-13T09:00:00Z', completedAt: '2026-07-13T09:04:00Z', updatedAt: '2026-07-13T09:04:00Z', createdAt: '2026-07-13T09:00:00Z', nextAction: 'download', taskId: 'synthetic-task', taskLinkStatus: 'linked', artifactId: 'synthetic-artifact' }]
          : [{ id: 'run-today', configId: syntheticConfig.id, provider: 'mailchimp', account: syntheticConfig.account, scopeLabel: syntheticConfig.scopeLabel, runKey: todayRunKey, status: 'pending', requestedAt: '2026-07-14T09:00:00Z', updatedAt: '2026-07-14T09:01:00Z', createdAt: '2026-07-14T09:00:00Z', errorCode: 'provider-concurrency', errorMessage: 'A completed account export is still inside the provider 24-hour window.', nextAction: 'wait', retryAfter: '2026-07-14T09:04:00Z' }],
      });
      const completed = await newPage(browser, surface, viewport, completedPayload, async route => {
        completedPosts++; completedSubmittedKey = route.request().postDataJSON().runKey; completedState = 'pending';
        await new Promise(resolve => setTimeout(resolve, 60));
        return route.fulfill({ status: 202, json: { export: { status: 'pending', runKey: completedSubmittedKey } } });
      });
      await expect(completed.page.locator('[data-export-state="completed"]')).toBeVisible();
      await expect(completed.page.getByText(/linked · synthetic-task/)).toBeVisible();
      await completed.page.getByRole('button', { name: 'Download ZIP' }).click();
      await expect(completed.page.getByRole('status')).toContainText('five minutes');
      await expect(completed.page.locator('a[href^="s3://"]')).toHaveCount(0);
      await assertNoOverflow(completed.page, viewport.width);
      await completed.page.screenshot({ path: path.join(screenshots, `${surface.label}-${viewport.label}-completed.png`), fullPage: true });
      const startNextDay = completed.page.getByRole('button', { name: 'Start daily export' });
      await startNextDay.focus(); await completed.page.keyboard.press('Enter');
      await expect(startNextDay).toBeDisabled();
      await expect(completed.page.locator('[data-export-state="pending"]')).toBeVisible();
      expect(completedPosts).toBe(1);
      expect(completedSubmittedKey).toBe(todayRunKey);
      await expect(completed.page.getByText(/24-hour window/)).toBeVisible();
      await completed.page.screenshot({ path: path.join(screenshots, `${surface.label}-${viewport.label}-completed-started.png`), fullPage: true });
      await completed.context.close();

      const configs = categories.map(([category], index) => ({ ...syntheticConfig, id: `config-${index}`, account: `Synthetic ${category}` }));
      const exports = categories.map(([category, nextAction], index) => ({
        id: `run-${index}`, configId: `config-${index}`, provider: 'mailchimp', account: `Synthetic ${category}`,
        scopeLabel: syntheticConfig.scopeLabel, runKey: '2026-07-12', status: category === 'provider-concurrency' ? 'pending' : 'failed',
        requestedAt: '2026-07-14T09:00:00Z', updatedAt: '2026-07-14T09:01:00Z', createdAt: '2026-07-14T09:00:00Z',
        errorCode: category, errorMessage: `Safe ${category} operator message.`, nextAction,
      }));
      let failedSubmittedKey, failedPosts = 0;
      const errors = await newPage(browser, surface, viewport, { configs, exports }, async route => {
        failedPosts++; failedSubmittedKey = route.request().postDataJSON().runKey;
        await new Promise(resolve => setTimeout(resolve, 60));
        return route.fulfill({ status: 202, json: { export: { status: 'failed' } } });
      });
      for (const [category] of categories) await expect(errors.page.getByText(category, { exact: true })).toBeVisible();
      const retryFailed = errors.page.getByRole('button', { name: 'Advance / retry' }).first();
      await retryFailed.focus(); await errors.page.keyboard.press('Enter');
      await expect(retryFailed).toBeDisabled();
      await expect.poll(() => failedPosts).toBe(1);
      expect(failedSubmittedKey).toBe('2026-07-12');
      await assertNoOverflow(errors.page, viewport.width);
      await errors.page.screenshot({ path: path.join(screenshots, `${surface.label}-${viewport.label}-errors.png`), fullPage: true });
      await errors.context.close();

      const unavailable = await newPage(browser, surface, viewport, new Error('Synthetic unavailable'));
      await expect(unavailable.page.getByRole('status')).toContainText('Could not load');
      await assertNoOverflow(unavailable.page, viewport.width);
      await unavailable.page.screenshot({ path: path.join(screenshots, `${surface.label}-${viewport.label}-unavailable.png`), fullPage: true });
      await unavailable.context.close();
    }
  });
}
