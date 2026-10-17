const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
let server, agreement;
test.beforeAll(async () => {
  server = await startOwnedTestServer();
  const response = await fetch(`${server.baseURL}/api/tuition`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    studentName: 'Synthetic Student', title: 'Deferred installment', trigger: 'First paid employment', status: 'conditional', amount: '900', currency: 'EUR',
  }) });
  if (!response.ok) throw new Error(await response.text());
  agreement = await response.json();
});
test.afterAll(async () => stopOwnedTestServer(server));
test('individual tuition has an editable billing home and retains its real condition with no invented due date', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: server.baseURL });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/bookkeeping?view=tuition&agreement=${agreement.id}`);
  await expect(page.getByRole('heading', { name: 'Tuition agreements & installments' })).toBeVisible();
  const form = page.locator('[data-tuition-form]');
  await expect(form.locator('[name="studentName"]')).toHaveValue('Synthetic Student');
  await expect(form.locator('[name="trigger"]')).toHaveValue('First paid employment');
  await expect(form.locator('[name="dueOn"]')).toHaveValue('');
  await form.locator('[name="notes"]').fill('Synthetic billing condition retained');
  await form.getByRole('button', { name: 'Save agreement' }).click();
  await expect(form.locator('[name="notes"]')).toHaveValue('Synthetic billing condition retained');
  await expect(form.locator('[name="dueOn"]')).toHaveValue('');
  await expect.poll(async () => (await (await fetch(`${server.baseURL}/api/tuition/${agreement.id}`)).json()).notes).toBe('Synthetic billing condition retained');
  const stored = await (await fetch(`${server.baseURL}/api/tuition/${agreement.id}`)).json();
  expect(stored.trigger).toBe('First paid employment');
  expect(stored.dueOn).toBeNull();
  await form.locator('[name="amount"]').fill('');
  await form.locator('[name="currency"]').fill('');
  await form.getByRole('button', { name: 'Save agreement' }).click();
  await expect.poll(async () => (await (await fetch(`${server.baseURL}/api/tuition/${agreement.id}`)).json()).version).toBe(3);
  const cleared = await (await fetch(`${server.baseURL}/api/tuition/${agreement.id}`)).json();
  expect(cleared.amount).toBeUndefined(); expect(cleared.currency).toBeUndefined();
  const screenshot = (name) => process.env.DATAOPS_SCREENSHOT_DIR ? path.join(process.env.DATAOPS_SCREENSHOT_DIR, name) : testInfo.outputPath(name);
  await page.locator('.bookkeeping-surface').evaluate((node) => { for (let current = node; current; current = current.parentElement) current.scrollTop = 0; });
  await page.screenshot({ path: screenshot('dataops-sponsor-pipeline-tuition-local-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => globalThis.dakitShell?.toggleDrawer(document.querySelector('.dk-shell'), false));
  await page.waitForTimeout(250);
  await page.locator('.bookkeeping-surface').evaluate((node) => { for (let current = node; current; current = current.parentElement) current.scrollTop = 0; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: screenshot('dataops-sponsor-pipeline-tuition-local-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
  await context.close();
});

test('retries failed loads, ignores stale searches and selections, and submits a form once', async ({ browser }) => {
  const created = await fetch(`${server.baseURL}/api/tuition`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    studentName: 'Synthetic Beta', title: 'Second installment', trigger: 'Actual agreed condition', status: 'conditional',
  }) });
  const beta = await created.json();
  const context = await browser.newContext({ baseURL: server.baseURL }); const page = await context.newPage();
  let failOnce = true, oldSearchSeen = false, releaseSearch;
  const searchGate = new Promise((resolve) => { releaseSearch = resolve; });
  await page.route('**/api/tuition?*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('search');
    if (failOnce) { failOnce = false; return route.fulfill({ status: 503, json: { error: 'Synthetic initial outage' } }); }
    if (q === 'old') { oldSearchSeen = true; await searchGate; return route.fulfill({ json: { items: [{ id: 'stale', studentName: 'Stale search result', title: 'Old', trigger: 'Old', status: 'due' }], total: 1, nextCursor: null } }); }
    return route.continue();
  });
  await page.goto('/bookkeeping?view=tuition');
  await expect(page.locator('[data-tuition-status]')).toContainText('Synthetic initial outage');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[data-tuition-list]')).toContainText('Synthetic Beta');
  await page.locator('[data-tuition-search]').fill('old'); await expect.poll(() => oldSearchSeen).toBe(true);
  await page.locator('[data-tuition-search]').fill('Synthetic');
  await expect(page.locator('[data-tuition-list]')).toContainText('Synthetic Beta');
  releaseSearch(); await page.waitForTimeout(250);
  await expect(page.locator('[data-tuition-list]')).not.toContainText('Stale search result');
  let releaseDetail, detailSeen = false;
  const detailGate = new Promise((resolve) => { releaseDetail = resolve; });
  await page.route(`**/api/tuition/${agreement.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    detailSeen = true; await detailGate; return route.fulfill({ json: { ...agreement, studentName: 'Stale detail result' } });
  });
  await page.locator(`[data-tuition-open="${agreement.id}"]`).click(); await expect.poll(() => detailSeen).toBe(true);
  await page.locator(`[data-tuition-open="${beta.id}"]`).click();
  await expect(page.locator('[data-tuition-form] [name="studentName"]')).toHaveValue('Synthetic Beta');
  releaseDetail(); await page.waitForTimeout(200);
  await expect(page.locator('[data-tuition-form] [name="studentName"]')).toHaveValue('Synthetic Beta');
  await expect(page).toHaveURL(new RegExp(`agreement=${beta.id}`));
  let puts = 0, releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  await page.route(`**/api/tuition/${beta.id}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts++; await saveGate; return route.continue();
  });
  await page.locator('[data-tuition-form]').evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => puts).toBe(1);
  await expect(page.getByRole('button', { name: 'Save agreement' })).toBeDisabled();
  releaseSave();
  await expect.poll(async () => (await (await fetch(`${server.baseURL}/api/tuition/${beta.id}`)).json()).version).toBe(2);
  expect(puts).toBe(1);
  await page.route(`**/api/tuition/${agreement.id}`, (route) => route.fulfill({ status: 404, json: { error: 'Synthetic missing selected agreement' } }));
  await page.locator(`[data-tuition-open="${agreement.id}"]`).click();
  await expect(page.locator('[data-tuition-form]')).toHaveCount(0);
  await expect(page.locator('[data-tuition-detail]')).toContainText('Could not load the selected agreement');
  await expect(page).toHaveURL(new RegExp(`agreement=${agreement.id}`));
  await context.close();
});
