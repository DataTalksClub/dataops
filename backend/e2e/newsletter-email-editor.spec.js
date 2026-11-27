const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

// The newsletter email is built in DataOps: start an empty draft (nothing is
// imported), add blocks from the type picker, watch the live preview follow the
// unsaved form, open the full rendered email, and see that only the owner can
// approve (this E2E actor is not the owner). No page ever offers a Relay import,
// a Relay sync or the retired Markdown package.

const SCREENSHOTS = process.env.NEWSLETTER_EDITOR_SCREENSHOT_DIR || '';
let server;
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('newsletter-email-editor') },
  });
});

test.afterAll(async () => {
  await stopOwnedTestServer(server);
});

test('builds an issue email in DataOps with a live preview, and approval stays with the owner', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ baseURL: server.baseURL, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const browserRelayCalls = [];
  page.on('request', (req) => { if (/relay\.datatalks\.club/.test(req.url())) browserRelayCalls.push(req.url()); });
  try {
    const created = await context.request.post('/api/newsletter-issues', {
      data: { kind: 'weekly', publicationDate: '2027-04-04', issueNumber: 977, status: 'drafting', slots: { primary: {}, secondary: {} } },
    });
    expect(created.status(), await created.text()).toBe(201);
    const issue = await created.json();

    await page.goto(`/newsletter/${issue.id}`);
    await expect(page.locator('[data-start-draft]')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Import blocks from Relay');
    await page.locator('[data-start-draft]').click();
    await expect(page.locator('[data-block-id]')).toHaveCount(1);

    await page.locator('[data-add-block]').click();
    await page.locator('[data-block-picker] [data-block-type="feature"]').click();
    await expect(page.locator('[data-block-id]')).toHaveCount(2);
    const form = page.locator('[data-block-form]');
    await form.locator('input[name="title"]').fill('E2E feature title');
    await expect(page.locator('[data-live-preview]')).toHaveAttribute('srcdoc', /E2E feature title/);
    await form.locator('[data-action="save"]').click();
    await expect(page.locator('[data-editor-status]')).toContainText('Saved Feature');

    const envelope = page.locator('[data-envelope-form]');
    await envelope.locator('input[name="subject"]').fill('E2E subject | DataTalks.Club Weekly');
    await envelope.locator('[data-action="save-envelope"]').click();
    await expect(page.locator('[data-editor-status]')).toContainText('Subject saved');
    await expect(page.locator('[data-approval-state]')).toHaveText('Not approved');
    for (const retired of ['Sync with Relay', 'Check Relay', 'Edit Markdown', 'Markdown &']) {
      await expect(page.locator('body')).not.toContainText(retired);
    }
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/editor-1280.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'the editor fits a phone width').toBeLessThanOrEqual(1);
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/editor-390.png`, fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/newsletter-issues/${issue.id}/preview`);
    await expect(page.locator('[data-email-frame]')).toHaveAttribute('srcdoc', /E2E feature title/);
    await expect(page.locator('[data-envelope]')).toContainText('E2E subject | DataTalks.Club Weekly');
    await expect(page.locator('[data-review-panel]')).toContainText('Only the owner approves');
    await expect(page.locator('[data-approve-form]')).toHaveCount(0);
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/full-email-1280.png`, fullPage: true });

    const draft = await (await context.request.get(`/api/newsletter-issues/${issue.id}/draft`)).json();
    const approve = await context.request.post(`/api/newsletter-issues/${issue.id}/draft/approve`, {
      data: { version: draft.draft.version, payloadHash: draft.draft.payloadHash },
    });
    expect(approve.status()).toBe(403);
    expect((await approve.json()).code).toBe('newsletter_owner_required');
    expect(browserRelayCalls).toEqual([]);
  } finally {
    await context.close();
  }
});
