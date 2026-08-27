// Issue 204 slice 2: Inbox and Assistants own their mutation feedback.
// Browser assertions target the visible surface that initiated each operation;
// the shell status cluster is not used for migrated flows.
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
  __dirname, '..', '..', '.tmp', 'screenshots', 'issue-204', 'slice-02',
);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

let server;
let baseURL;

async function ownedContext(browser, options = {}) {
  const context = await browser.newContext({ baseURL, ...options });
  const health = await context.request.get('/api/health');
  assertOwnedServerResponse(server, health, 'issue 204 slice 2 health');
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

async function json(response) {
  return response.json();
}

async function keepWithinNestedViewport(page, viewport, locators) {
  await expect(viewport).toBeVisible();
  const viewportBox = await viewport.boundingBox();
  expect(viewportBox).toBeTruthy();
  if (!viewportBox) return;

  const boxes = [];
  for (const locator of locators) {
    const box = await locator.boundingBox();
    expect(box).toBeTruthy();
    if (box) boxes.push(box);
  }
  expect(boxes).toHaveLength(locators.length);

  const viewportTop = viewportBox.y;
  const viewportBottom = viewportBox.y + viewportBox.height;
  let minimumDelta = -Infinity;
  let maximumDelta = Infinity;
  for (const box of boxes) {
    minimumDelta = Math.max(
      minimumDelta,
      box.y + box.height - viewportBottom,
    );
    maximumDelta = Math.min(maximumDelta, box.y - viewportTop);
  }
  expect(
    minimumDelta,
    `nested viewport cannot contain capture frame: ${JSON.stringify({
      minimumDelta,
      maximumDelta,
      viewportBox,
      boxes,
    })}`,
  ).toBeLessThanOrEqual(maximumDelta);
  const delta = minimumDelta > 0
    ? minimumDelta
    : maximumDelta < 0
      ? maximumDelta
      : 0;
  if (delta !== 0) {
    await viewport.evaluate((node, scrollDelta) => {
      node.scrollTop += scrollDelta;
    }, delta);
  }

  for (const locator of locators) {
    const box = await locator.boundingBox();
    expect(box).toBeTruthy();
    if (!box) continue;
    expect(box.y, `capture element above nested viewport: ${JSON.stringify(box)}`)
      .toBeGreaterThanOrEqual(viewportTop);
    expect(
      box.y + box.height,
      `capture element below nested viewport: ${JSON.stringify(box)}`,
    ).toBeLessThanOrEqual(viewportBottom);
  }
}

async function screenshot(page, name, anchor, block = 'center', frameLocators = []) {
  if (anchor) {
    await anchor.evaluate((node, targetBlock) => {
      node.scrollIntoView({ block: targetBlock, inline: 'nearest' });
    }, block);
  }
  if (frameLocators.length) {
    await keepWithinNestedViewport(
      page,
      page.locator('#library-view'),
      frameLocators,
    );
  }
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: true,
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
  const metrics = await locator.evaluate((node) => ({
    bodyView: document.body.dataset.workspaceView,
    innerWidth: window.innerWidth,
    mediaMatches: matchMedia('(max-width: 768px)').matches,
    minHeight: getComputedStyle(node).minHeight,
    height: getComputedStyle(node).height,
  }));
  expect(box.height, JSON.stringify(metrics)).toBeGreaterThanOrEqual(44);
  expect(box.width, JSON.stringify(metrics)).toBeGreaterThanOrEqual(44);
}

test.describe('issue 204 slice 2 owning-surface feedback', () => {
  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot('issue-204-slice-2'),
      },
    });
    baseURL = server.baseURL;
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });

  test('Inbox keeps validation, failure, conflict recovery, and durable success in the initiating surface', async ({ browser }) => {
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await page.goto(`${baseURL}/#/inbox`);

    const summary = page.locator('[data-summary-id="inbox"]');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute('data-summary-state', /ready|empty/);
    const capture = page.locator('.intake-panel').filter({ hasText: 'Capture a new intake item' });
    await capture.locator('summary').click();
    await capture.getByRole('button', { name: 'Capture intake' }).click();
    await expect(capture.locator('.intake-create-feedback .form-feedback-error'))
      .toContainText('Add a note or title before capturing intake');

    const failedTitle = `Slice 2 retained intake ${Date.now()}`;
    await capture.locator('[data-intake-create-title]').fill(failedTitle);
    await capture.locator('[data-intake-create-note]').fill('Retain this safe intake input.');
    await setFaults(context.request, [{ method: 'POST', path: '/api/intake', status: 503 }]);
    await capture.getByRole('button', { name: 'Capture intake' }).click();
    await expect(capture.locator('.intake-create-feedback .form-feedback-error'))
      .toContainText('Synthetic route failure (503)');
    await expect(capture.locator('[data-intake-create-title]')).toHaveValue(failedTitle);
    await expect(capture.getByRole('button', { name: 'Capture intake' })).toBeEnabled();
    await screenshot(page, 'inbox-capture-failure-desktop-1440x900');

    await clearFaults(context.request);
    await capture.getByRole('button', { name: 'Capture intake' }).click();
    await expect(page.locator('.intake-row', { hasText: failedTitle })).toBeVisible();
    await expect(capture.locator('.form-feedback-status'))
      .toContainText('visible in the refreshed Inbox');
    await screenshot(page, 'inbox-capture-success-desktop-1440x900');

    const originalResponse = await context.request.post('/api/intake', {
      data: {
        source: 'manual',
        title: `Slice 2 duplicate source ${Date.now()}`,
        note: 'Original safe request for conflict recovery.',
        dataClass: 'internal',
      },
    });
    expect(originalResponse.status()).toBe(201);
    const original = (await json(originalResponse)).item;
    await page.locator('.intake-row', { hasText: failedTitle }).click();
    const detail = page.locator('.intake-detail');
    await expect(detail).toBeVisible();
    await detail.getByText('Resolution actions').click();
    await detail.locator('summary').filter({ hasText: 'Mark duplicate' }).click();
    const duplicateAction = detail.locator('[data-intake-submit="mark-duplicate"]')
      .locator('xpath=ancestor::details[1]');
    await duplicateAction.getByLabel('Duplicate of').fill(original.id);
    await duplicateAction.getByLabel('Reason').fill('Same safe upstream request.');
    await setFaults(context.request, [{
      method: 'POST',
      path: `/api/intake/${new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('intakeId')}/mark-duplicate`,
      status: 409,
    }]);
    await duplicateAction.getByRole('button', { name: 'Mark duplicate' }).click();
    await expect(detail.locator('.intake-inline-feedback[role="alert"]'))
      .toContainText('Synthetic route failure (409)');
    await expect(duplicateAction.getByLabel('Reason')).toHaveValue('Same safe upstream request.');
    await expect(detail.getByRole('button', { name: 'Reload current item' })).toBeVisible();
    await screenshot(
      page,
      'inbox-conflict-recovery-desktop-1440x900',
      detail.locator('.intake-inline-feedback'),
    );

    await clearFaults(context.request);
    await detail.getByRole('button', { name: 'Reload current item' }).click();
    await expect(detail.locator('.intake-inline-feedback'))
      .toContainText('current intake is refreshed');
    const retryDuplicateAction = detail.locator(
      '[data-intake-submit="mark-duplicate"]',
    ).locator('xpath=ancestor::details[1]');
    const duplicateResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST'
        && url.pathname.endsWith('/api/intake/'
          + new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('intakeId')
          + '/mark-duplicate')
        && response.status() === 200;
    });
    await retryDuplicateAction.getByRole('button', { name: 'Mark duplicate' }).click();
    await duplicateResponse;
    await expect(detail).toContainText('This item is duplicate and read-only');
    await expect(detail.locator('.intake-history')).toContainText('Marked as duplicate');

    await page.setViewportSize(MOBILE);
    await page.goto(`${baseURL}/#/inbox`);
    await expect(page.locator('[data-summary-id="inbox"]')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const mobileCapture = page.locator('.intake-panel').filter({ hasText: 'Capture a new intake item' });
    await mobileCapture.locator('summary').click();
    await expectTouchTarget(mobileCapture.getByRole('button', { name: 'Capture intake' }));
    await expectTouchTarget(page.locator('.intake-filter-bar button').first());
    await screenshot(page, 'inbox-queue-mobile-390x844');
    await context.close();
  });

  test('Assistants keeps creation and lifecycle conflict feedback in the initiating surface', async ({ browser }) => {
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await page.goto(`${baseURL}/#/assistants`);

    const summary = page.locator('[data-summary-id="assistants"]');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute('data-summary-state', /ready|empty/);
    await setFaults(context.request, [{ method: 'GET', path: '/api/assistant-jobs', status: 503, remaining: 5 }]);
    await page.reload();
    await expect(summary).toHaveAttribute('data-summary-state', 'unavailable');
    await expect(summary).toContainText('Synthetic route failure (503)');
    await expect(summary.getByRole('button', { name: /Retry loading assistants/ })).toBeVisible();
    await screenshot(page, 'assistants-unavailable-desktop-1440x900');
    await clearFaults(context.request);
    await summary.getByRole('button', { name: /Retry loading assistants/ }).click();
    await expect(summary).toHaveAttribute('data-summary-state', /ready|empty/);

    const cardResponse = await context.request.post('/api/cards', {
      data: { title: `Slice 2 assistant card ${Date.now()}`, anchorDate: '2026-08-26' },
    });
    expect(cardResponse.status()).toBe(201);
    const card = (await json(cardResponse)).card;
    await page.reload();
    const createPanel = page.locator('.assistant-panel').filter({ hasText: 'Request DataOps Assistant help' });
    const form = createPanel.locator('.assistant-create-form');
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: 'Ask DataOps Assistant' }).click();
    await expect(createPanel.locator('.assistant-create-feedback .form-feedback-error'))
      .toContainText('Select a Card or Task');
    await expect(form.locator('[data-assistant-card]')).toBeFocused();

    await form.locator('[data-assistant-card]').selectOption(card.id);
    await form.getByLabel('Assistant type').fill('podcast');
    const assistantTitle = `Slice 2 retained assistant ${Date.now()}`;
    await form.getByLabel('Title').fill(assistantTitle);
    await setFaults(context.request, [{ method: 'POST', path: '/api/assistant-jobs', status: 503 }]);
    await form.getByRole('button', { name: 'Ask DataOps Assistant' }).click();
    await expect(createPanel.locator('.assistant-create-feedback .form-feedback-error'))
      .toContainText('Synthetic route failure (503)');
    await expect(form.getByLabel('Title')).toHaveValue(assistantTitle);
    await screenshot(page, 'assistants-create-failure-desktop-1440x900');

    await clearFaults(context.request);
    await form.getByRole('button', { name: 'Ask DataOps Assistant' }).click();
    await expect(page).toHaveURL(/assistantJobId=/);
    await expect(page.locator('.assistant-detail h3')).toHaveText(assistantTitle);
    await expect(page.locator('.assistant-queue .assistant-job-row', { hasText: assistantTitle })).toBeVisible();

    const draftResponse = await context.request.post('/api/assistant-jobs', {
      data: {
        assistantType: 'podcast',
        title: `Slice 2 draft conflict ${Date.now()}`,
        cardId: card.id,
        inputRefs: [{ type: 'card', id: card.id }],
        approvalRequired: true,
        maxAttempts: 2,
      },
    });
    expect(draftResponse.status()).toBe(201);
    const draft = (await json(draftResponse)).job;
    await page.goto(`${baseURL}/#/assistants?assistantJobId=${draft.id}`);
    const detail = page.locator('.assistant-detail');
    await expect(detail.getByRole('button', { name: 'Submit' })).toBeVisible();
    await setFaults(context.request, [{
      method: 'POST',
      path: `/api/assistant-jobs/${draft.id}/submit`,
      status: 409,
    }]);
    await detail.getByRole('button', { name: 'Submit' }).click();
    await expect(detail.locator('.assistant-detail-feedback .form-feedback-error'))
      .toContainText('Synthetic route failure (409)');
    await expect(detail.getByRole('button', { name: 'Reload current job' })).toBeVisible();
    await screenshot(
      page,
      'assistants-lifecycle-conflict-desktop-1440x900',
      detail.locator('.assistant-detail-feedback'),
      'center',
      [
        page.locator('[data-assistant-create]'),
        detail,
        detail.locator('.assistant-detail-feedback'),
        detail.getByRole('button', { name: 'Submit' }),
        detail.getByRole('button', { name: 'Reload current job' }),
      ],
    );

    await clearFaults(context.request);
    await detail.getByRole('button', { name: 'Reload current job' }).click();
    await expect(detail.getByRole('button', { name: 'Submit' })).toBeVisible();
    await detail.getByRole('button', { name: 'Submit' }).click();
    await expect(detail.locator('.assistant-detail-feedback .form-feedback-status'))
      .toContainText('refreshed queue');

    await page.setViewportSize(MOBILE);
    await page.goto(`${baseURL}/#/assistants`);
    await expect(page.locator('[data-summary-id="assistants"]')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectTouchTarget(page.locator('.assistant-filter-bar button').first());
    await expectTouchTarget(page.locator('[data-assistant-create]'));
    await screenshot(page, 'assistants-queue-mobile-390x844');
    await context.close();
  });
});
