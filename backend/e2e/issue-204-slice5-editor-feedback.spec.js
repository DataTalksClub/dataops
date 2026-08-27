// Issue 204 slice 5: editor-owned feedback, keyboard/focus contracts, and
// stale mutation responses. Fixtures are synthetic and public-safe.
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
  'slice-05',
);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const EDITOR_PATH = 'content/testing/slice5-editor.md';
const RACE_OLD_PATH = 'content/testing/slice5-race-old.md';
const RACE_NEW_PATH = 'content/testing/slice5-race-new.md';
const EDITOR_TITLE = 'Synthetic Slice Five Editor';
const RACE_OLD_TITLE = 'Synthetic Stale Save Source';
const RACE_NEW_TITLE = 'Synthetic Newer Document';
const UPDATED_STEP_TEXT = 'Commit the updated synthetic editor step.';
const DISCARDED_SUMMARY_TEXT = 'This keyboard edit must be discarded.';

function syntheticSop(title, summary, step) {
  return [
    '---',
    `title: "${title}"`,
    'doc_type: sop',
    'schema_version: 1',
    'systems: [browser]',
    'tags: [slice-five]',
    '---',
    '',
    `# ${title}`,
    '',
    '<!-- sop-section-start: summary -->',
    '## Summary',
    summary,
    '<!-- sop-section-end -->',
    '',
    '<!-- sop-section-start: prerequisites -->',
    '## Prerequisites',
    'Use only the synthetic browser fixture.',
    '<!-- sop-section-end -->',
    '',
    '<!-- sop-section-start: procedure -->',
    '## Procedure',
    '',
    '<!-- sop-step-start id=1 action="verify" -->',
    `1.  ${step}`,
    '<!-- sop-step-end -->',
    '<!-- sop-section-end -->',
    '',
    '<!-- sop-section-start: validation -->',
    '## Validation',
    'The visible editor state names the current synthetic document.',
    '<!-- sop-section-end -->',
    '',
    '<!-- sop-section-start: troubleshooting -->',
    '## Troubleshooting',
    'Retry the synthetic save if the route is temporarily unavailable.',
    '<!-- sop-section-end -->',
    '',
    '<!-- sop-section-start: references -->',
    '## References',
    'No external references are used.',
    '<!-- sop-section-end -->',
    '',
  ].join('\n');
}

let server;
const activeContexts = new Set();

async function ownedContext(browser, options = {}) {
  const context = await browser.newContext({
    baseURL: server.baseURL,
    ...options,
  });
  activeContexts.add(context);
  const health = await context.request.get('/api/health');
  assertOwnedServerResponse(server, health, 'issue 204 slice 5 health');
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

async function navigateToDocument(page, visiblePath) {
  await page.evaluate((nextPath) => {
    history.pushState({}, '', nextPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, visiblePath);
}

async function openFromProcesses(page, visiblePath, title) {
  await page.goto('/#/processes');
  await expect(page.locator('#document-list')).toBeVisible();
  await navigateToDocument(page, visiblePath);
  await expect(page.locator('#rendered-view .block-title')).toHaveText(title, {
    timeout: 20_000,
  });
  await expect(page.locator('#doc-state')).toBeHidden();
  await expect(page.locator('#editor')).toBeEnabled();
  const expectedPath = visiblePath.replace(/^\/+/, '');
  await expect(page.locator('#document-path')).toHaveText(
    expectedPath.startsWith('content/') ? expectedPath : `content/${expectedPath}`,
  );
}

async function capture(page, name) {
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

async function expectContainedInViewport(page, locator) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  const viewport = page.viewportSize();
  expect(viewport).toBeTruthy();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

test.describe('issue 204 slice 5 editor feedback and race evidence', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot('issue-204-slice-5-editor', {
          [EDITOR_PATH]: syntheticSop(
            EDITOR_TITLE,
            'A public-safe fixture for visible editor feedback and keyboard behavior.',
            'Open the original synthetic editor step.',
          ),
          [RACE_OLD_PATH]: syntheticSop(
            RACE_OLD_TITLE,
            'A public-safe source document whose save response is delayed.',
            'Edit the stale save source before changing routes.',
          ),
          [RACE_NEW_PATH]: syntheticSop(
            RACE_NEW_TITLE,
            'A public-safe destination document that must remain authoritative.',
            'Keep the newer document visible after the old save resolves.',
          ),
        }),
      },
    });
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

  test('keeps editor outcomes visible, keyboard-editable, focused, and usable on mobile', async ({ browser }) => {
    test.setTimeout(90_000);
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await openFromProcesses(page, '/testing/slice5-editor.md', EDITOR_TITLE);

    const inlineStatus = page.locator('#editor-inline-status');
    const saveState = page.locator('#editor-save-state');
    const saveButton = page.locator('#editor-save-button');
    const discardButton = page.locator('#editor-discard-button');
    const summaryBody = page.locator(
      '.block-section[data-section="summary"] .block-section-body',
    );
    const stepBody = page.locator(
      '.block-section[data-section="procedure"] .block-step[data-step-id="1"] .block-step-body',
    );

    await expect(inlineStatus).toBeHidden();
    await expect(saveButton).toBeDisabled();
    await expect(stepBody).toContainText('Open the original synthetic editor step.');

    // Escape cancels an inline edit without losing the previously rendered
    // value; the editor itself is keyboard-entered and receives focus.
    const originalSummary = await summaryBody.innerText();
    await summaryBody.click();
    const summaryEditor = summaryBody.locator('textarea.inline-editor');
    await expect(summaryEditor).toBeFocused();
    await summaryEditor.fill(DISCARDED_SUMMARY_TEXT);
    await summaryEditor.press('Escape');
    await expect(summaryBody.locator('.inline-editor')).toHaveCount(0);
    await expect(summaryBody).toContainText(originalSummary);
    await expect(summaryBody).not.toContainText(DISCARDED_SUMMARY_TEXT);

    // Ctrl+Enter commits the multiline inline editor, creates a local draft,
    // and keeps the changed content visible before a network save.
    await stepBody.click();
    const stepEditor = stepBody.locator('textarea.inline-editor');
    await expect(stepEditor).toBeFocused();
    await stepEditor.fill(UPDATED_STEP_TEXT);
    await stepEditor.press('Control+Enter');
    await expect(stepBody.locator('.inline-editor')).toHaveCount(0);
    await expect(stepBody).toContainText(UPDATED_STEP_TEXT);
    await expect(page.locator('#changes-section')).toBeVisible();
    await expect(saveButton).toBeEnabled();
    await expect(discardButton).toBeEnabled();
    await expect(saveState).toHaveText('Unsaved changes');

    // A failed save is announced in the editor-owned live region and retains
    // the valid attempted edit so the operator can recover without retyping.
    await setFaults(context.request, [{
      method: 'PUT',
      path: '/docs',
      query: { path: EDITOR_PATH },
      status: 503,
    }]);
    await saveButton.click();
    await expect(inlineStatus).toContainText('Synthetic route failure (503)');
    await expect(inlineStatus).toHaveAttribute('data-feedback-state', 'error');
    await expect(inlineStatus).toHaveAttribute('role', 'alert');
    await expect(inlineStatus).toHaveAttribute('aria-live', 'assertive');
    await expect(saveButton).toBeEnabled();
    await expect(saveState).toHaveText('Unsaved changes');
    await expect(saveState).toBeFocused();
    await expect(stepBody).toContainText(UPDATED_STEP_TEXT);
    await expect(page.locator('#editor')).toHaveValue(new RegExp(UPDATED_STEP_TEXT));
    await capture(page, 'editor-save-failure-desktop-1440x900');

    // A delayed success exposes the pending contract before the authoritative
    // refreshed result clears the pending-draft panel and restores focus.
    await clearFaults(context.request);
    await setFaults(context.request, [{
      method: 'PUT',
      path: '/docs',
      query: { path: EDITOR_PATH },
      delayMs: 1_000,
    }]);
    await saveButton.click();
    await expect(inlineStatus).toHaveText('Saving…');
    await expect(inlineStatus).toHaveAttribute('data-feedback-state', 'pending');
    await expect(inlineStatus).toHaveAttribute('role', 'status');
    await expect(inlineStatus).toHaveAttribute('aria-live', 'polite');
    await expect(saveButton).toBeDisabled();
    await capture(page, 'editor-save-pending-desktop-1440x900');

    await expect(inlineStatus).toHaveText(`Saved ${EDITOR_PATH}.`, {
      timeout: 20_000,
    });
    await expect(inlineStatus).toHaveAttribute('data-feedback-state', 'success');
    await expect(inlineStatus).toHaveAttribute('role', 'status');
    await expect(saveState).toBeFocused();
    await expect(page.locator('#changes-section')).toBeHidden();
    await expect(saveButton).toBeDisabled();

    const saved = await context.request.get(
      `/docs?path=${encodeURIComponent(EDITOR_PATH)}`,
    );
    expect(saved.status()).toBe(200);
    expect((await saved.json()).content).toContain(UPDATED_STEP_TEXT);

    // The same successful editor outcome remains readable and contained at
    // the requested phone viewport, including the sticky action footer.
    await page.setViewportSize(MOBILE);
    await expect(inlineStatus).toBeVisible();
    await expect(inlineStatus).toContainText(`Saved ${EDITOR_PATH}.`);
    await expectNoHorizontalOverflow(page);
    await expectContainedInViewport(page, page.locator('.document-editor-footer'));
    await expectContainedInViewport(page, discardButton);
    await expectContainedInViewport(page, saveButton);
    await capture(page, 'editor-save-success-mobile-390x844');
  });

  test('ignores a delayed save from the old document after the route changes', async ({ browser }) => {
    test.setTimeout(90_000);
    const context = await ownedContext(browser, { viewport: DESKTOP });
    const page = await context.newPage();
    await setupPageWithAuth(page);
    await openFromProcesses(page, '/testing/slice5-race-old.md', RACE_OLD_TITLE);

    const oldStepBody = page.locator(
      '.block-section[data-section="procedure"] .block-step[data-step-id="1"] .block-step-body',
    );
    await oldStepBody.click();
    const oldStepEditor = oldStepBody.locator('textarea.inline-editor');
    await oldStepEditor.fill('A stale save must not repaint the newer route.');
    await oldStepEditor.press('Control+Enter');

    await setFaults(context.request, [{
      method: 'PUT',
      path: '/docs',
      query: { path: RACE_OLD_PATH },
      delayMs: 1_500,
    }]);
    const delayedSave = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'PUT'
        && url.pathname === '/docs'
        && url.searchParams.get('path') === RACE_OLD_PATH
        && response.status() === 200;
    });
    await page.locator('#editor-save-button').click();
    await expect(page.locator('#editor-inline-status')).toHaveText('Saving…');

    await navigateToDocument(page, '/testing/slice5-race-new.md');
    const confirmModal = page.locator('#confirm-modal');
    await expect(confirmModal).toBeVisible();
    await expect(page.locator('#confirm-message')).toContainText('unsaved local changes');
    await page.locator('#confirm-ok').click();
    await expect(page.locator('#confirm-modal')).toBeHidden();
    await expect(page.locator('#rendered-view .block-title')).toHaveText(
      RACE_NEW_TITLE,
      { timeout: 20_000 },
    );
    await expect(page.locator('#document-path')).toHaveText(RACE_NEW_PATH);
    await expect(page.locator('#editor')).toHaveValue(new RegExp(
      'Keep the newer document visible after the old save resolves',
    ));

    await delayedSave;
    await expect(page.locator('#document-path')).toHaveText(RACE_NEW_PATH);
    await expect(page.locator('#rendered-view .block-title')).toHaveText(RACE_NEW_TITLE);
    await expect(page.locator('#editor-inline-status')).not.toContainText(
      `Saved ${RACE_OLD_PATH}.`,
    );
    await expectNoHorizontalOverflow(page);
    await capture(page, 'editor-stale-save-newer-route-desktop-1440x900');
  });
});
