const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

const screenshotDir = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots');

async function screenshot(page, name) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, name), fullPage: true });
}

test.describe('raw intake inbox workflow', () => {
  test('captures and triages intake into workflow context', async ({ page, request }) => {
    const suffix = uid();
    const bundleRes = await request.post('/api/bundles', {
      data: { title: 'Inbox Workflow ' + suffix, anchorDate: '2026-07-15', tags: ['podcast'] },
    });
    expect(bundleRes.status()).toBe(201);
    const bundle = (await bundleRes.json()).bundle;

    const taskRes = await request.post('/api/tasks', {
      data: {
        description: 'Existing inbox task ' + suffix,
        date: '2026-07-15',
        bundleId: bundle.id,
        tags: ['podcast'],
      },
    });
    expect(taskRes.status()).toBe(201);
    const task = await taskRes.json();

    const attachItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Attach intake ' + suffix,
        note: 'Attach this raw note to existing workflow context.',
        source: 'manual',
      },
    })).json()).item;
    const convertItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Convert intake ' + suffix,
        note: 'This should become an ad-hoc task.',
        source: 'manual',
      },
    })).json()).item;
    const originalItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Original duplicate source ' + suffix,
        note: 'Canonical source.',
        source: 'manual',
      },
    })).json()).item;
    const duplicateItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Duplicate source ' + suffix,
        note: 'Same as original.',
        source: 'manual',
      },
    })).json()).item;
    const blockedItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Blocked intake ' + suffix,
        note: 'Needs requester follow-up.',
        source: 'manual',
      },
    })).json()).item;

    await page.goto('/#/');
    await expect(page.locator('[data-testid="dashboard-intake-risk"]')).toContainText('Untriaged intake');
    await screenshot(page, 'issue-31-dashboard-placement.png');

    await page.goto('/#/inbox');
    await expect(page.locator('[data-testid="manual-intake-form"]')).toBeVisible();
    await page.locator('#intake-create-note').fill('Manual portal intake ' + suffix + ' https://example.com/manual-' + suffix);
    await page.locator('#intake-create-title').fill('Manual intake ' + suffix);
    await page.locator('#intake-create-data-class').selectOption('private');
    await page.locator('#intake-create-tags').fill('manual,podcast');
    await screenshot(page, 'issue-31-manual-intake-form.png');
    await page.getByRole('button', { name: 'Capture intake' }).click();
    await expect(page.locator('[data-testid="inbox-queue"]')).toContainText('Manual intake ' + suffix);
    await expect(page.locator('[data-testid="inbox-detail"]')).toContainText('Raw intake excerpt');
    await screenshot(page, 'issue-31-inbox-queue-detail.png');

    await page.locator('[data-intake-row="' + attachItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-task-id').fill(task.id);
    await page.locator('#intake-bundle-id').selectOption(bundle.id);
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Attach' }).click();
    await expect(page.locator('[data-testid="inbox-detail"]')).toContainText('attached');
    await expect(page.locator('[data-testid="inbox-detail"]')).toContainText(task.id);
    await screenshot(page, 'issue-31-attach-task-bundle.png');

    await page.locator('[data-intake-row="' + blockedItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-reason').fill('Waiting for requester context');
    await page.locator('#intake-waiting-for').fill('Requester');
    await page.locator('#intake-follow-up-at').fill('2026-07-16');
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Block' }).click();
    await expect(page.locator('[data-testid="inbox-detail"]')).toContainText('blocked');
    await screenshot(page, 'issue-31-blocked-state.png');

    await page.locator('[data-intake-filter="all"]').click();
    await page.locator('[data-intake-row="' + duplicateItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-duplicate-id').fill(originalItem.id);
    await page.locator('#intake-reason').fill('Same source request');
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Duplicate' }).click();
    await expect(page.locator('[data-testid="inbox-detail"]')).toContainText('duplicate');
    await screenshot(page, 'issue-31-duplicate-state.png');

    await page.locator('[data-intake-row="' + attachItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-assistant-type').fill('podcast');
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Assistant ready' }).click();
    await expect(page.locator('[data-testid="inbox-detail"]')).toContainText('assistant ready');
    await screenshot(page, 'issue-31-assistant-ready.png');

    await page.locator('[data-intake-row="' + convertItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-bundle-id').selectOption(bundle.id);
    await page.locator('#intake-task-date').fill('2026-07-15');
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Convert to task' }).click();
    await expect(page).toHaveURL(/#\/bundles/);
    await expect(page.getByRole('link', { name: 'Open bundle Inbox Workflow ' + suffix })).toBeVisible();
    await screenshot(page, 'issue-31-convert-to-task.png');
  });
});
