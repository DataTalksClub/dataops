// Issue 204 slice 3: Task/Card actions recover in the surface that owns them.
// All records are synthetic and every assertion waits on the visible owning node.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
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
  'slice-03',
);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

let server;
let baseURL;
const activeContexts = new Set();

async function ownedContext(browser, options = {}) {
  const context = await browser.newContext({ baseURL, ...options });
  activeContexts.add(context);
  const health = await context.request.get('/api/health');
  assertOwnedServerResponse(server, health, 'issue 204 slice 3 health');
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

async function createCard(request, title) {
  const response = await request.post('/api/cards', {
    data: {
      title,
      anchorDate: '2026-08-12',
      description: 'Public-safe synthetic Card for recovery evidence.',
      stage: 'preparation',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).card;
}

async function createTask(request, description, cardId) {
  const response = await request.post('/api/tasks', {
    data: {
      description,
      date: '2026-08-12',
      ...(cardId ? { cardId } : {}),
    },
  });
  expect(response.status()).toBe(201);
  const payload = await response.json();
  return payload.task || payload;
}

async function capture(page, name, anchor) {
  if (anchor) await anchor.scrollIntoViewIfNeeded();
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

async function expectTouchTarget(locator) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
}

async function expectNoSeriousA11y(page, selector) {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = result.violations.filter((violation) =>
    ['critical', 'serious'].includes(violation.impact),
  );
  expect(
    serious,
    serious.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
  ).toEqual([]);
}

test.describe('issue 204 slice 3 Task/Card action recovery', () => {
  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot('issue-204-slice-3'),
      },
    });
    baseURL = server.baseURL;
  });

  test.afterEach(async () => {
    for (const context of activeContexts) {
      if (context.isClosed()) continue;
      await clearFaults(context.request).catch(() => {});
      await context.close().catch(() => {});
    }
    activeContexts.clear();
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });

  test('Task panel exposes pending, failure, conflict, retry, and durable success states', async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);

    const pendingTask = await createTask(
      context.request,
      `Synthetic pending Task ${Date.now()}`,
    );
    await page.goto(`/#/tasks?taskId=${pendingTask.id}`);
    await expect(page.locator('#task-panel-title')).toHaveText(pendingTask.description);
    await setFaults(context.request, [{
      method: 'PUT',
      path: `/api/tasks/${pendingTask.id}`,
      delayMs: 650,
    }]);
    await page.locator('#task-panel').getByRole('button', { name: 'Mark done' }).click();
    const pending = page.locator('#task-panel [data-task-mutation-feedback="pending"]');
    await expect(pending).toBeVisible();
    await expect(page.locator('#task-panel').getByRole('button', { name: 'Mark done' }))
      .toBeDisabled();
    await capture(page, 'task-pending-desktop-1440x900');
    await expectNoSeriousA11y(page, '#task-panel');
    await expect(page.locator('#task-panel [data-task-mutation-feedback="success"]'))
      .toBeVisible();
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('done');
    await capture(
      page,
      'task-success-desktop-1440x900',
      page.locator('#task-panel [data-task-mutation-feedback="success"]'),
    );
    await clearFaults(context.request);
    await page.reload();
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('done');

    const failedTask = await createTask(
      context.request,
      `Synthetic recoverable Task ${Date.now()}`,
    );
    await page.goto(`/#/tasks?taskId=${failedTask.id}`);
    await expect(page.locator('#task-panel-title')).toHaveText(failedTask.description);
    await setFaults(context.request, [{
      method: 'PUT',
      path: `/api/tasks/${failedTask.id}`,
      status: 503,
    }]);
    await page.locator('#task-panel').getByRole('button', { name: 'Mark done' }).click();
    const failure = page.locator('#task-panel [data-task-mutation-feedback="error"]');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('Could not update task: Synthetic route failure (503)');
    await expect(failure.getByRole('button', { name: 'Retry change' })).toBeVisible();
    await expect(failure.getByRole('button', { name: 'Reload current Task' })).toBeVisible();
    await expect(failure.getByRole('button', { name: 'Discard change' })).toBeVisible();
    await expect(failure).toBeFocused();
    await expectNoSeriousA11y(page, '#task-panel');
    await capture(page, 'task-failure-desktop-1440x900', failure);
    await page.setViewportSize(MOBILE);
    await expectNoHorizontalOverflow(page);
    for (const button of await failure.getByRole('button').all()) {
      await expectTouchTarget(button);
    }
    await expectNoSeriousA11y(page, '#task-panel');
    await capture(page, 'task-failure-mobile-390x844', failure);
    await page.setViewportSize(DESKTOP);
    await clearFaults(context.request);
    await failure.getByRole('button', { name: 'Retry change' }).click();
    await expect(page.locator('#task-panel [data-task-mutation-feedback="success"]'))
      .toBeVisible();
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('done');

    const conflictTask = await createTask(
      context.request,
      `Synthetic conflict Task ${Date.now()}`,
    );
    await page.goto(`/#/tasks?taskId=${conflictTask.id}`);
    await expect(page.locator('#task-panel-title')).toHaveText(conflictTask.description);
    const external = await context.request.put(`/api/tasks/${conflictTask.id}`, {
      data: {
        comment: 'Synthetic concurrent operator edit.',
        expectedVersion: conflictTask.version,
      },
    });
    expect(external.status()).toBe(200);
    await page.locator('#task-panel').getByRole('button', { name: 'Mark done' }).click();
    const conflict = page.locator('#task-panel .task-version-conflict[role="alert"]');
    await expect(conflict).toBeVisible();
    await expect(conflict).toBeFocused();
    await expect(conflict).toContainText('This Task changed elsewhere');
    await expect(conflict).toContainText('Your retained change: Set status to done');
    await expect(conflict.getByRole('button', { name: 'Review latest' })).toBeVisible();
    await expect(conflict.getByRole('button', { name: 'Retry my change' })).toBeVisible();
    await expect(conflict.getByRole('button', { name: 'Discard my change' })).toBeVisible();
    await expectNoSeriousA11y(page, '#task-panel');
    await capture(page, 'task-conflict-desktop-1440x900', conflict);
    await conflict.getByRole('button', { name: 'Retry my change' }).click();
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('done');
    await expect(page.locator('#task-panel [data-task-mutation-feedback="success"]'))
      .toBeVisible();
    await capture(
      page,
      'task-recovery-success-desktop-1440x900',
      page.locator('#task-panel [data-task-mutation-feedback="success"]'),
    );
    await page.reload();
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('done');
  });

  test('Card panel keeps stage recovery local and operable on a 390px viewport', async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await ownedContext(browser, { viewport: MOBILE });
    const page = await context.newPage();
    await setupPageWithAuth(page);

    const card = await createCard(
      context.request,
      `Synthetic mobile recovery Card ${Date.now()}`,
    );
    await createTask(
      context.request,
      `Synthetic Card checklist ${Date.now()}`,
      card.id,
    );
    await page.goto(`/#/cards?cardId=${card.id}`);
    await expect(page.locator('#card-panel-title')).toHaveText(card.title);
    const stage = page.locator('#card-panel .card-stage-select');
    await setFaults(context.request, [{
      method: 'PUT',
      path: `/api/cards/${card.id}`,
      status: 503,
    }]);
    await stage.selectOption('after-event');
    const failure = page.locator('#card-panel [data-card-mutation-feedback="error"]');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('Could not update stage: Synthetic route failure (503)');
    await expect(failure).toBeFocused();
    await expect(stage).toHaveValue('after-event');
    for (const button of await failure.getByRole('button').all()) {
      await expectTouchTarget(button);
    }
    await expectTouchTarget(stage);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11y(page, '#card-panel');
    await capture(page, 'card-failure-mobile-390x844', failure);

    await page.setViewportSize(DESKTOP);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11y(page, '#card-panel');
    await capture(page, 'card-failure-desktop-1440x900', failure);
    await page.setViewportSize(MOBILE);

    await clearFaults(context.request);
    await failure.getByRole('button', { name: 'Retry change' }).click();
    const success = page.locator('#card-panel [data-card-mutation-feedback="success"]');
    await expect(success).toBeVisible();
    await expect(success).toContainText('Card stage is saved in the refreshed Card');
    await expect(page.locator('#card-panel .card-stage-select')).toHaveValue('after-event');
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11y(page, '#card-panel');
    await capture(page, 'card-recovery-success-mobile-390x844', success);
  });
});
