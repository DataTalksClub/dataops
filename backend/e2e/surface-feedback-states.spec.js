// Issue 204 slice 1: Home, Tasks, Users and Device own their visible feedback.
//
// Every wait here targets a visible owning-surface node or an armed response.
// Nothing in this file waits on the hidden shell status cluster.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');
const { berlinBusinessDate } = require('./helpers/business-date');
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require('./helpers/isolated-capability-server');

const SCREENSHOT_DIR = path.resolve(
  __dirname, '..', '..', '.tmp', 'screenshots', 'issue-204', 'slice-01',
);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

let server;
let baseURL;

async function ownedContext(browser, options = {}) {
  const context = await browser.newContext({ baseURL, ...options });
  const health = await context.request.get('/api/health');
  assertOwnedServerResponse(server, health, 'surface feedback health');
  return context;
}

async function setFaults(request, faults) {
  const response = await request.post('/__e2e__/route-faults', { data: { faults } });
  expect(response.ok()).toBe(true);
}

async function clearFaults(request) {
  const response = await request.delete('/__e2e__/route-faults');
  expect(response.ok()).toBe(true);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
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

test.describe('issue 204 owning-surface feedback', () => {
  test.beforeAll(async () => {
    const cacheRoot = createDocsCacheRoot('issue-204-surface-feedback');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: cacheRoot,
        E2E_TEMPLATE_ACTOR_ID: '00000000-0000-0000-0000-000000000001',
      },
    });
    baseURL = server.baseURL;
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });

  test('the Tasks queue reports loading, ready, and unavailable work in its own summary', async ({ browser }) => {
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);

    let releaseTasks;
    const tasksReady = new Promise((resolve) => { releaseTasks = resolve; });
    await page.route('**/api/tasks*', async (route) => {
      await tasksReady;
      await route.continue();
    });
    await page.goto(`${baseURL}/tasks`);
    const queueSummary = page.locator('[data-summary-id="tasks-queue"]');
    await expect(queueSummary).toHaveAttribute('data-summary-state', 'loading');
    releaseTasks();
    await expect(queueSummary).toHaveAttribute('data-summary-state', 'empty');
    await expect(queueSummary).toContainText('No tasks are open in this queue.');
    await expectNoHorizontalOverflow(page);
    await shot(page, 'queue-ready-desktop-1440x900');
    await page.unroute('**/api/tasks*');
    const taskResponse = await context.request.post('/api/tasks', { data: {
      description: 'Retained work during a source outage', date: berlinBusinessDate(Date.now()),
      assigneeId: '00000000-0000-0000-0000-000000000001',
    } });
    expect(taskResponse.status()).toBe(201);
    const retainedTask = await taskResponse.json();
    await page.reload();
    await expect(queueSummary).toHaveCount(0);
    await expect(page.locator('.ops-queue-total')).toContainText('1 open');
    await setFaults(context.request, [{ method: 'GET', path: '/api/cards', status: 503, remaining: 20 }]);
    await page.reload();
    await expect(queueSummary).toHaveAttribute('data-summary-state', 'partial');
    await expect(queueSummary).toContainText('Some task sources are unavailable.');
    await expect(page.locator('.ops-queue-row strong')).toHaveText('Retained work during a source outage');
    await shot(page, 'queue-partial-retained-work-desktop-1440x900');

    // Work sources fail: the queue names the outage in the surface and offers retry.
    await setFaults(context.request, [
      { method: 'GET', path: '/api/tasks', status: 503, remaining: 20 },
      { method: 'GET', path: '/api/cards', status: 503, remaining: 20 },
    ]);
    await page.reload();
    // Whether the snapshot degrades to unavailable or partial depends on which
    // sources answered; either way the queue names the failure and offers
    // recovery in its own summary rather than reporting a clean count.
    await expect(queueSummary).toHaveAttribute('data-summary-state', /unavailable|partial/);
    await expect(queueSummary).toContainText('Some task sources are unavailable.');
    await expect(queueSummary.locator('.surface-summary-detail')).toHaveCount(0);
    await expect(page.locator('.ops-queue-row')).toHaveCount(0);
    await expect(page.locator('.ops-queue-board[data-load-state="unavailable"] .ops-empty'))
      .toContainText('Live work data unavailable.');
    const retry = queueSummary.getByRole('button', { name: /Retry loading (tasks|work)/ });
    await expect(retry).toBeVisible();
    const retryBox = await retry.boundingBox();
    expect(retryBox.height).toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);
    await shot(page, 'queue-unavailable-desktop-1440x900');

    // Keyboard-only recovery works from the summary that owns it.
    await retry.focus();
    const [recovered] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/tasks')),
      page.keyboard.press('Enter'),
    ]);
    expect(recovered.status()).toBe(503);

    await clearFaults(context.request);
    await retry.focus();
    await expect(retry).toBeFocused();
    const [healthyResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/tasks')),
      page.keyboard.press('Enter'),
    ]);
    expect(healthyResponse.status()).toBe(200);
    await expect(queueSummary).toHaveCount(0);
    await expect(page.locator('.ops-queue-row strong')).toHaveText('Retained work during a source outage');
    await expect(page.locator('.ops-queue-total')).toContainText('1 open');
    await shot(page, 'queue-recovered-desktop-1440x900');

    await clearFaults(context.request);

    await page.setViewportSize(MOBILE);
    await page.goto(`${baseURL}/tasks`);
    // The prior Tasks outage snapshot remains in memory across workspace routes.
    // Reload after clearing faults to prove the fresh mobile work presentation.
    await page.reload();
    await expect(queueSummary).toHaveCount(0);
    await expect(page.locator('.ops-queue-total')).toContainText('1 open');
    await expectNoHorizontalOverflow(page);
    await shot(page, 'queue-ready-mobile-390x844');
    await expectNoHorizontalOverflow(page);
    const deleted = await context.request.delete(`/api/tasks/${retainedTask.id}`, {
      data: { expectedVersion: retainedTask.version },
    });
    expect(deleted.ok()).toBe(true);
    await context.close();
  });

  test('a failed quick Task keeps its error, its input, and its retry inside the form', async ({ browser }) => {
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await page.goto(`${baseURL}/`);
    await expect(page.locator('.operations-home')).toBeVisible();

    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.locator('.quick-form');
    await expect(form).toBeVisible();

    // Validation belongs to the field, and focus moves to it.
    await form.getByRole('button', { name: 'Create task' }).click();
    await expect(form.locator('.field-error').first()).toContainText('Task description is required.');
    // The message exists once, inside the form that owns it, and is visible.
    await expect(page.getByText('Task description is required.')).toHaveCount(1);
    await expect(page.getByText('Task description is required.')).toBeVisible();
    await shot(page, 'quick-task-validation-desktop-1440x900');

    await setFaults(context.request, [{ method: 'POST', path: '/api/tasks', status: 503 }]);
    await form.getByRole('textbox').first().fill('Synthetic public-safe task');
    await form.getByRole('button', { name: 'Create task' }).click();
    const failure = form.locator('.form-feedback-error');
    await expect(failure).toContainText('Synthetic route failure (503)');
    await expect(failure).toContainText('Select Create task to retry.');
    await expect(form.getByRole('textbox').first()).toHaveValue('Synthetic public-safe task');
    await expect(form.getByRole('button', { name: 'Create task' })).toBeEnabled();
    await shot(page, 'quick-task-failure-desktop-1440x900');

    await clearFaults(context.request);
    await form.getByRole('button', { name: 'Create task' }).click();
    await expect(page.locator('#task-panel-title')).toHaveText('Synthetic public-safe task');
    await context.close();
  });

  test('Users and Device carry their own load, pending, and outcome states', async ({ browser }) => {
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);

    await setFaults(context.request, [{ method: 'GET', path: '/api/users', status: 503, remaining: 5 }]);
    await page.goto(`${baseURL}/users`);
    const usersSummary = page.locator('[data-summary-id="users"]');
    await expect(usersSummary).toHaveAttribute('data-summary-state', 'unavailable');
    await expect(usersSummary).toContainText('Synthetic route failure (503)');
    await shot(page, 'users-unavailable-desktop-1440x900');

    await clearFaults(context.request);
    await usersSummary.getByRole('button', { name: /Retry loading users/ }).click();
    // Loaded: the table speaks; only an empty list keeps a summary line.
    await expect(page.locator('.ops-users-table, [data-summary-id="users"][data-summary-state="empty"]').first()).toBeVisible();
    await shot(page, 'users-ready-desktop-1440x900');

    await page.route('**/work/api/me', route => route.fulfill({ json: { user: { email: 'operator@example.test' } } }));
    await page.route('**/work/api/auth/device/pending?**', route => route.fulfill({ status: 404, json: { error: 'Not found' } }));
    await page.goto(`${baseURL}/device`);
    await expect(page.locator('.dk-auth-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Authorize a device', exact: true })).toBeVisible();
    await page.getByLabel('Device code', { exact: true }).fill('ZZZZ-9999');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Code not found' })).toBeVisible();
    const deviceError = page.getByRole('alert');
    await expect(deviceError).toContainText('This code is wrong, expired, or already used.');
    await expect(page.getByRole('button', { name: 'Enter another code' })).toBeEnabled();
    await shot(page, 'device-unknown-code-desktop-1440x900');
    await page.setViewportSize(MOBILE);
    await expect(page.locator('.dk-auth-card')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, 'device-mobile-390x844');
    await context.close();
  });

  test('quick Task and Card 409 recovery stays in the owning form', async ({ browser }) => {
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await page.goto(`${baseURL}/`);
    await expect(page.locator('.operations-home')).toBeVisible();

    await page.getByRole('button', { name: 'New task' }).click();
    const taskForm = page.locator('.quick-form');
    await expect(taskForm).toBeVisible();
    await taskForm.getByRole('textbox').first().fill('Synthetic public-safe task');
    await setFaults(context.request, [
      { method: 'POST', path: '/api/tasks', status: 409, remaining: 2 },
    ]);
    await taskForm.getByRole('button', { name: 'Create task' }).click();
    const taskFeedback = taskForm.locator('.form-feedback');
    await expect(taskFeedback).toHaveAttribute('data-feedback-state', 'conflict');
    await expect(taskFeedback).toContainText('conflict while creating this Task');
    await expect(taskForm.getByRole('textbox').first()).toHaveValue('Synthetic public-safe task');
    await expect(taskForm.getByRole('button', { name: 'Create task' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Review current work' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
    await shot(page, 'quick-task-conflict-desktop-1440x900');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(taskForm).toHaveCount(0);
    await clearFaults(context.request);

    await page.getByRole('button', { name: 'Create card' }).click();
    const cardForm = page.locator('.quick-form');
    await expect(cardForm.locator('select:not([disabled])')).toBeVisible();
    const templateOption = cardForm.locator('select option:not([value=""])').first();
    await expect(templateOption).toHaveCount(1);
    await cardForm.locator('select').selectOption({ index: 1 });
    const cardTitle = cardForm.locator('input[type="text"]');
    await cardTitle.fill('Synthetic public-safe card');
    await setFaults(context.request, [
      { method: 'POST', path: '/api/cards', status: 409, remaining: 2 },
    ]);
    await cardForm.getByRole('button', { name: 'Create card' }).click();
    const cardFeedback = cardForm.locator('.form-feedback');
    await expect(cardFeedback).toHaveAttribute('data-feedback-state', 'conflict');
    await expect(cardFeedback).toContainText('Template changed since this form was opened');
    await expect(cardTitle).toHaveValue('Synthetic public-safe card');
    await expect(cardForm.getByRole('button', { name: 'Create card' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Review latest Templates' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
    await shot(page, 'quick-card-conflict-desktop-1440x900');
    await page.getByRole('button', { name: 'Close' }).click();
    await clearFaults(context.request);
    await context.close();
  });

  test('Users save success confirms the refreshed list', async ({ browser }) => {
    const context = await ownedContext(browser, {
      baseURL,
      viewport: DESKTOP,
      extraHTTPHeaders: { 'x-user-id': '00000000-0000-0000-0000-000000000001' },
    });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await page.goto(`${baseURL}/users`);
    await expect(page.locator('.ops-users-table, [data-summary-id="users"][data-summary-state="empty"]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add user' })).toBeVisible();
    await page.getByRole('button', { name: 'Add user' }).click();
    const userForm = page.locator('.ops-user-form');
    await userForm.getByLabel('Name').fill('Synthetic User');
    // One email is one account, so a retry must not reuse the address.
    const email = `synthetic-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.invalid`;
    await userForm.getByLabel('Email').fill(email);
    await userForm.getByRole('button', { name: 'Create user' }).click();
    const usersOutcome = page.locator('.ops-users-outcome');
    await expect(usersOutcome).toBeVisible();
    await expect(usersOutcome).toContainText('Synthetic User added.');
    await expect(page.getByText(email)).toBeVisible();
    await shot(page, 'users-save-success-desktop-1440x900');
    await context.close();
  });
});
