const { test, expect } = require('./fixtures');

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

async function screenshot(page, name) {
  await page.screenshot({ path: `../.tmp/screenshots/${name}.png`, fullPage: true });
}

async function podcastRow(page, text) {
  const row = page.locator('.task-checklist-row', { hasText: text }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  return row;
}

test.describe('Podcast operator workflow slice (#9)', () => {
  test('runs the first Podcast workflow through proof, assistant output, waiting, and stage change', async ({ page }) => {
    test.setTimeout(90000);
    const suffix = uid();
    const topic = 'Vector Search Ops ' + suffix;
    const guest = 'Jane Guest ' + suffix;
    let delayedTemplates = false;
    await page.route('**/api/templates', async (route) => {
      if (!delayedTemplates) {
        delayedTemplates = true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await route.continue();
    });

    await page.goto('/#/bundles');
    await page.waitForSelector('#podcast-start-btn');
    await expect(page.locator('#podcast-start-btn')).toBeDisabled();
    await expect(page.locator('#podcast-start-btn')).toHaveText('Loading Podcast...');
    await expect(page.locator('#podcast-start-btn')).toBeEnabled({ timeout: 15000 });
    await page.fill('#podcast-topic', topic);
    await page.fill('#podcast-guest', guest);
    await page.fill('#podcast-anchor', '2026-08-17');
    await page.fill('#podcast-email', 'jane-' + suffix + '@example.com');
    await page.fill('#podcast-source-note', 'Community referral');
    await screenshot(page, `podcast-start-${suffix}`);
    await page.click('#podcast-start-btn');

    await page.waitForSelector('[data-testid="workflow-context"]', { timeout: 20000 });
    await expect(page.locator('.bundle-detail-header h2')).toContainText(topic);
    await expect(page.locator('[data-testid="stage-badge"]')).toHaveText('preparation');
    await expect(page.locator('[data-testid="progress-badge"]')).toContainText('/42 done');
    await expect(page.locator('.bundle-links-editable')).toContainText('Podcast document');
    await screenshot(page, `podcast-detail-${suffix}`);

    await page.click('.btn-back');
    await page.waitForFunction(() => location.hash === '#/');
    await expect(page.locator('.dashboard-bundle-card', { hasText: topic })).toBeVisible({ timeout: 15000 });
    await page.locator('.dashboard-bundle-card', { hasText: topic }).click();
    await page.waitForSelector('[data-testid="workflow-context"]');
    await screenshot(page, `podcast-dashboard-open-${suffix}`);

    await page.click('.btn-back');
    await page.goto('/#/bundles');
    await page.waitForSelector('.bundle-card');
    await page.locator('.bundle-card', { hasText: topic }).locator('.bundle-card-title').click();
    await page.waitForSelector('[data-testid="workflow-context"]');

    const lumaRow = await podcastRow(page, 'Create an event in Luma');
    await expect(lumaRow.locator('.process-doc-link')).toContainText('Creating events (Webinar, Workshop and Podcast) on Luma');
    await expect(lumaRow.locator('.process-doc-summary')).toContainText('Create Luma event pages');
    await expect(lumaRow.locator('.process-doc-meta')).toContainText('Phase: event-setup');
    await expect(lumaRow.locator('.process-doc-action')).toHaveText('Open SOP');
    await expect(lumaRow.locator('.task-status-checkbox')).toBeDisabled();
    await lumaRow.locator('.required-link-input').fill('https://lu.ma/' + suffix);
    await lumaRow.locator('[data-save-required-link]').click();
    await page.waitForSelector('[data-testid="workflow-context"]');
    const lumaRowAfter = await podcastRow(page, 'Create an event in Luma');
    await expect(lumaRowAfter.locator('.task-status-checkbox')).toBeEnabled();
    await lumaRowAfter.locator('.task-status-checkbox').check();
    await page.waitForSelector('[data-testid="progress-badge"]');
    await screenshot(page, `podcast-proof-link-${suffix}`);
    const lumaTaskId = await lumaRowAfter.getAttribute('data-task-row');
    await page.evaluate((taskId) => window.api.tasks.update(taskId, {
      instructionDocId: 'sop.media.podcast.unmapped-legacy-doc',
    }), lumaTaskId);
    await page.reload();
    await page.waitForSelector('[data-testid="workflow-context"]');
    await expect(page.locator('.bundle-detail-header h2')).toContainText(topic);
    const unresolvedDocRow = await podcastRow(page, 'Create an event in Luma');
    await expect(unresolvedDocRow.locator('.process-doc-context--unresolved')).toContainText('Unresolved document');
    await expect(unresolvedDocRow.locator('.process-doc-action')).toHaveText('Try docs resolver');

    const bannerRow = await podcastRow(page, 'Create a banner for a podcast event in Figma');
    await expect(bannerRow.locator('.task-status-checkbox')).toBeDisabled();
    await bannerRow.locator('.required-file-input').setInputFiles({
      name: 'podcast-banner-proof.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('podcast banner proof ' + suffix),
    });
    await bannerRow.locator('[data-upload-required-file]').click();
    await page.waitForSelector('.proof-present', { timeout: 15000 });
    const bannerRowAfter = await podcastRow(page, 'Create a banner for a podcast event in Figma');
    await expect(bannerRowAfter.locator('.task-status-checkbox')).toBeEnabled();
    await bannerRowAfter.locator('.task-status-checkbox').check();
    await screenshot(page, `podcast-proof-file-${suffix}`);

    const docRow = await podcastRow(page, 'Create a podcast document with the questions');
    await docRow.locator('.assistant-mini-btn').click();
    await expect(page.locator('#assistant-request-overlay')).toContainText('Create a podcast document with the questions');
    await page.locator('#assistant-request-urls').fill('https://example.com/podcast-doc-source-' + suffix);
    await page.locator('#assistant-request-notes').fill('Podcast document source notes for ' + guest);
    await page.getByRole('button', { name: 'Queue DataOps Assistant job' }).click();
    await expect(page.locator('[data-testid="assistants-panel"]')).toContainText('queued', { timeout: 15000 });
    await page.locator('[data-testid="assistants-panel"] [data-assistant-action="run-dry"]').last().click();
    await expect(page.locator('[data-testid="assistants-panel"]')).toContainText('waiting approval', { timeout: 15000 });
    await page.locator('[data-testid="assistants-panel"] [data-assistant-action="approve"]').last().click();
    await expect(page.locator('[data-testid="workflow-artifacts"]')).toContainText('approved', { timeout: 15000 });
    const docRowAfter = await podcastRow(page, 'Create a podcast document with the questions');
    await expect(docRowAfter.locator('.artifact-chip--approved')).toBeVisible();
    await expect(docRowAfter.locator('.task-status-checkbox')).toBeEnabled();
    await docRowAfter.locator('.task-status-checkbox').check();
    await screenshot(page, `dataops-podcast-output-${suffix}`);

    const waitRow = await podcastRow(page, 'Agree on a date');
    await waitRow.locator('.waiting-for-input').fill(guest);
    await waitRow.locator('.waiting-channel-input').selectOption('email');
    await waitRow.locator('.waiting-followup-input').fill('2000-01-01');
    await waitRow.locator('.waiting-note-input').fill('Waiting for date confirmation');
    await waitRow.locator('[data-mark-waiting-task]').click();
    await expect(page.locator('.badge-waiting', { hasText: guest })).toBeVisible({ timeout: 15000 });
    await screenshot(page, `podcast-waiting-${suffix}`);

    await page.goto('/#/');
    await expect(page.locator('#dashboard-tasks')).toContainText('Agree on a date', { timeout: 15000 });
    const dashboardWaitRow = page.locator('[data-task-row]', { hasText: 'Agree on a date' });
    const dashboardWaitTaskId = await dashboardWaitRow.getAttribute('data-task-row');
    const dashboardWaitActions = page.locator('[data-task-actions-row="' + dashboardWaitTaskId + '"]');
    await dashboardWaitActions.locator('.follow-up-note').fill('Guest replied with dates');
    await dashboardWaitActions.locator('[data-follow-up-action="response-received"]').click();
    await expect(page.locator('#dashboard-tasks')).not.toContainText('Agree on a date', { timeout: 15000 });

    await page.goto('/#/bundles');
    await page.reload();
    await page.waitForSelector('.bundle-card');
    await page.locator('.bundle-card', { hasText: topic }).locator('.bundle-card-title').click();
    await page.waitForSelector('[data-testid="workflow-context"]');

    const streamRow = await podcastRow(page, 'Actual stream');
    await expect(streamRow.locator('.task-status-checkbox')).toBeDisabled();
    await streamRow.locator('.required-link-input').fill('https://youtube.com/watch?v=' + suffix);
    await streamRow.locator('[data-save-required-link]').click();
    await page.waitForSelector('[data-testid="workflow-context"]');
    const streamRowAfter = await podcastRow(page, 'Actual stream');
    await streamRowAfter.locator('.task-status-checkbox').check();
    await expect(page.locator('[data-testid="stage-badge"]')).toHaveText('after-event', { timeout: 15000 });
    await screenshot(page, `podcast-stage-after-event-${suffix}`);
  });
});
