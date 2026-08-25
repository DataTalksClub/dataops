// Issue 204 slice 1: Home, Tasks, Users and Device own their visible feedback.
//
// Every wait here targets a visible owning-surface node or an armed response.
// Nothing in this file waits on the hidden shell status cluster.
const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { setupPageWithAuth } = require('./helpers/auth');

const ROOT = path.resolve(__dirname, '..', '..');
const SCREENSHOT_DIR = path.resolve(
  ROOT, '.tmp', 'screenshots', 'issue-204', 'slice-01',
);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

let server;
let baseURL;

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const { port } = listener.address();
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForServer(url) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok) return resolve();
      } catch {}
      if (Date.now() >= deadline) {
        return reject(new Error('Issue 204 test server timed out'));
      }
      setTimeout(poll, 100);
    };
    poll();
  });
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
    const port = await freePort();
    baseURL = `http://127.0.0.1:${port}`;
    const cacheRoot = createDocsCacheRoot('issue-204-surface-feedback');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    server = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/test-server.ts'], {
      cwd: path.join(ROOT, 'backend'),
      detached: true,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        IS_LOCAL: 'true',
        SKIP_AUTH: 'true',
        DATAOPS_DOCS_DOMAIN: '1',
        DTC_OFFLINE: '1',
        DTC_CACHE_ROOT: cacheRoot,
        FRONTEND_ROOT: path.join(ROOT, 'frontend'),
        E2E_TEMPLATE_ACTOR_ID: '00000000-0000-0000-0000-000000000001',
        CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
        CONVERSATIONAL_EXECUTION_ENABLED: 'false',
        CONVERSATIONAL_ENABLED_PLUGINS: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    await waitForServer(baseURL);
  });

  test.afterAll(() => {
    if (!server) return;
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  });

  test('Home and Tasks report loading, ready, and unavailable work in their own summaries', async ({ browser }) => {
    const context = await browser.newContext({ baseURL, viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);

    await page.goto(`${baseURL}/#/`);
    const homeSummary = page.locator('[data-summary-id="home"]');
    await expect(homeSummary).toBeVisible();
    await expect(
      page.locator('.operations-home[data-operations-work-loaded="true"]'),
    ).toBeVisible();
    await expect(homeSummary).toHaveAttribute('data-summary-state', /ready|empty/);
    await expect(homeSummary.locator('.surface-summary-state')).not.toBeEmpty();
    await expectNoHorizontalOverflow(page);
    await shot(page, 'home-ready-desktop-1440x900');

    // Work sources fail: Home names the outage in the surface and offers retry.
    await setFaults(context.request, [
      { method: 'GET', path: '/api/tasks', status: 503, remaining: 20 },
      { method: 'GET', path: '/api/cards', status: 503, remaining: 20 },
    ]);
    await page.reload();
    // Whether the snapshot degrades to unavailable or partial depends on which
    // sources answered; either way Home names the failure and offers recovery
    // in its own summary rather than reporting a clean count.
    await expect(homeSummary).toHaveAttribute('data-summary-state', /unavailable|partial/);
    await expect(homeSummary.locator('.surface-summary-detail')).toContainText('Synthetic route failure (503)');
    const retry = homeSummary.getByRole('button', { name: /Retry loading work/ });
    await expect(retry).toBeVisible();
    const retryBox = await retry.boundingBox();
    expect(retryBox.height).toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);
    await shot(page, 'home-unavailable-desktop-1440x900');

    // Keyboard-only recovery works from the summary that owns it.
    await retry.focus();
    const [recovered] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/work/api/tasks')),
      page.keyboard.press('Enter'),
    ]);
    expect(recovered.status()).toBe(503);

    await clearFaults(context.request);
    await page.reload();
    await expect(homeSummary).toHaveAttribute('data-summary-state', /ready|empty/);

    await setFaults(context.request, [
      { method: 'GET', path: '/api/tasks', status: 503, remaining: 20 },
      { method: 'GET', path: '/api/cards', status: 503, remaining: 20 },
    ]);
    await page.goto(`${baseURL}/#/tasks`);
    // A hash move reuses the snapshot already in memory; reload so the queue
    // fetches its own data under the armed failure.
    await page.reload();
    const queueSummary = page.locator('[data-summary-id="tasks-queue"]');
    await expect(queueSummary).toHaveAttribute('data-summary-state', /unavailable|partial/);
    await expect(queueSummary).toContainText('Synthetic route failure (503)');
    await expect(queueSummary.getByRole('button', { name: /Retry loading tasks/ })).toBeVisible();
    const unavailableLaneCounts = page.locator('.ops-queue-group [data-queue-count="unknown"]');
    await expect(unavailableLaneCounts.first()).toBeVisible();
    const unknownCountTexts = await unavailableLaneCounts.allTextContents();
    expect(unknownCountTexts.length).toBeGreaterThan(0);
    expect(unknownCountTexts.every((text) => text.trim() === '—')).toBe(true);
    expect(unknownCountTexts.includes('0')).toBe(false);
    await expect(queueSummary).not.toContainText('0 known');
    await shot(page, 'tasks-queue-degraded-desktop-1440x900');
    await clearFaults(context.request);

    await page.setViewportSize(MOBILE);
    await page.goto(`${baseURL}/#/`);
    await expect(homeSummary).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, 'home-ready-mobile-390x844');
    await page.goto(`${baseURL}/#/tasks`);
    await expect(queueSummary).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, 'tasks-queue-mobile-390x844');
    await context.close();
  });

  test('a failed quick Task keeps its error, its input, and its retry inside the form', async ({ browser }) => {
    const context = await browser.newContext({ baseURL, viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await page.goto(`${baseURL}/#/`);
    await expect(page.locator('[data-summary-id="home"]')).toBeVisible();

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
    const context = await browser.newContext({ baseURL, viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);

    await setFaults(context.request, [{ method: 'GET', path: '/api/users', status: 503, remaining: 5 }]);
    await page.goto(`${baseURL}/#/users`);
    const usersSummary = page.locator('[data-summary-id="users"]');
    await expect(usersSummary).toHaveAttribute('data-summary-state', 'unavailable');
    await expect(usersSummary).toContainText('Synthetic route failure (503)');
    await shot(page, 'users-unavailable-desktop-1440x900');

    await clearFaults(context.request);
    await usersSummary.getByRole('button', { name: /Retry loading users/ }).click();
    await expect(usersSummary).toHaveAttribute('data-summary-state', /ready|empty/);
    await shot(page, 'users-ready-desktop-1440x900');

    await page.goto(`${baseURL}/#/device`);
    const deviceSummary = page.locator('[data-summary-id="device"]');
    await expect(deviceSummary).toContainText('Enter the code shown by the DataOps CLI');
    await page.locator('.device-code-input').fill('ZZZZ-9999');
    await page.getByRole('button', { name: 'Continue' }).click();
    const deviceError = page.locator('.device-error');
    await expect(deviceError).toContainText('That code is not waiting for confirmation');
    await expect(deviceError).toContainText('retry device registration');
    await expect(deviceError).not.toContainText('Sign in to the portal');
    await expect(page.locator('.device-code-input')).toHaveValue('ZZZZ-9999');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await expect(deviceError).toBeVisible();
    await expect(page.getByText(await deviceError.innerText())).toHaveCount(1);
    await expect(deviceSummary).toHaveAttribute('data-summary-state', 'ready');
    await shot(page, 'device-unknown-code-desktop-1440x900');

    await page.setViewportSize(MOBILE);
    await expect(deviceSummary).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, 'device-mobile-390x844');
    await context.close();
  });

  test('quick Task and Card 409 recovery stays in the owning form', async ({ browser }) => {
    const context = await browser.newContext({ baseURL, viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await page.goto(`${baseURL}/#/`);
    await expect(page.locator('[data-summary-id="home"]')).toBeVisible();

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
    const context = await browser.newContext({
      baseURL,
      viewport: DESKTOP,
      extraHTTPHeaders: { 'x-user-id': '00000000-0000-0000-0000-000000000001' },
    });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await page.goto(`${baseURL}/#/users`);
    await expect(page.locator('[data-summary-id="users"]')).toHaveAttribute(
      'data-summary-state',
      /ready|empty/,
    );
    await expect(page.getByRole('button', { name: 'Add user' })).toBeVisible();
    await page.getByRole('button', { name: 'Add user' }).click();
    const userForm = page.locator('.ops-user-form');
    await userForm.getByLabel('Name').fill('Synthetic User');
    await userForm.getByLabel('Email').fill('synthetic-user@datatalks.club');
    await userForm.getByLabel('Password').fill('1111');
    await userForm.getByRole('button', { name: 'Create user' }).click();
    const usersOutcome = page.locator('.ops-users-outcome');
    await expect(usersOutcome).toBeVisible();
    await expect(usersOutcome).toContainText('Synthetic User added.');
    await expect(page.getByText('synthetic-user@datatalks.club')).toBeVisible();
    await shot(page, 'users-save-success-desktop-1440x900');
    await context.close();
  });
});
