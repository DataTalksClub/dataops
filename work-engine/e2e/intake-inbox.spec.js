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

    const adhocTaskRes = await request.post('/api/tasks', {
      data: {
        description: 'Existing ad-hoc inbox task ' + suffix,
        date: '2026-07-16',
        tags: ['podcast'],
      },
    });
    expect(adhocTaskRes.status()).toBe(201);
    const adhocTask = await adhocTaskRes.json();

    const attachTaskItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Attach task intake ' + suffix,
        note: 'Attach this raw note to existing workflow context.',
        source: 'manual',
      },
    })).json()).item;
    const attachAdhocTaskWorkflowItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Attach ad-hoc task and workflow intake ' + suffix,
        note: 'Attach this raw note to an ad-hoc task while preserving workflow context.',
        source: 'manual',
      },
    })).json()).item;
    const attachWorkflowItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Attach workflow intake ' + suffix,
        note: 'Attach this raw note to a workflow only.',
        source: 'manual',
      },
    })).json()).item;
    const failedAttachItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Failed attach intake ' + suffix,
        note: 'This should stay in Inbox when attach fails.',
        source: 'manual',
      },
    })).json()).item;
    const convertWorkflowItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Convert workflow intake ' + suffix,
        note: 'This should become a workflow-linked task.',
        source: 'manual',
      },
    })).json()).item;
    const convertAdhocItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Convert adhoc intake ' + suffix,
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
    const assistantItem = (await (await request.post('/api/intake', {
      data: {
        title: 'Assistant intake ' + suffix,
        note: 'Prepare this for assistant input refs.',
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

    await page.locator('[data-intake-row="' + attachTaskItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-task-id').fill(task.id);
    await page.locator('#intake-bundle-id').selectOption(bundle.id);
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Attach' }).click();
    await expect(page).toHaveURL(new RegExp('#/bundles\\?bundleId=' + bundle.id + '&taskId=' + task.id));
    await expect(page.locator('#bundle-detail')).toContainText('Inbox Workflow ' + suffix);
    await expect(page.locator('[data-task-row="' + task.id + '"]')).toBeVisible();
    await expect(page.locator('[data-task-row="' + task.id + '"]')).toHaveClass(/task-target-row/);
    await screenshot(page, 'issue-63-attach-task-destination.png');

    await page.goto('/#/inbox');
    await page.locator('[data-intake-row="' + attachAdhocTaskWorkflowItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-task-id').fill(adhocTask.id);
    await page.locator('#intake-bundle-id').selectOption(bundle.id);
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Attach' }).click();
    await expect(page).toHaveURL(new RegExp('#/tasks\\?taskId=' + adhocTask.id + '&date=2026-07-16&contextBundleId=' + bundle.id));
    await expect(page.locator('[data-testid="task-workflow-context"]')).toContainText('Inbox Workflow ' + suffix);
    await expect(page.locator('[data-testid="task-workflow-context"] a')).toHaveAttribute('href', new RegExp('#/bundles\\?bundleId=' + bundle.id + '$'));
    await expect(page.locator('[data-task-row="' + adhocTask.id + '"]')).toBeVisible();
    await expect(page.locator('[data-task-row="' + adhocTask.id + '"]')).toHaveClass(/task-target-row/);
    await screenshot(page, 'issue-63-attach-adhoc-task-workflow-destination.png');

    await page.goto('/#/inbox');
    await page.locator('[data-intake-row="' + attachWorkflowItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-bundle-id').selectOption(bundle.id);
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Attach' }).click();
    await expect(page).toHaveURL(new RegExp('#/bundles\\?bundleId=' + bundle.id + '$'));
    await expect(page.locator('#bundle-detail')).toContainText('Inbox Workflow ' + suffix);
    await screenshot(page, 'issue-63-attach-workflow-destination.png');

    await page.goto('/#/inbox');
    await page.locator('[data-intake-row="' + failedAttachItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-task-id').fill('missing-task-' + suffix);
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Attach' }).click();
    await expect(page).toHaveURL(/#\/inbox$/);
    await expect(page.locator('.error-banner')).toContainText('Task not found');
    await expect(page.locator('[data-testid="inbox-detail"]')).toContainText('Failed attach intake ' + suffix);

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

    await page.locator('[data-intake-row="' + assistantItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-assistant-type').fill('podcast');
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Assistant ready' }).click();
    await expect(page.locator('[data-testid="inbox-detail"]')).toContainText('assistant ready');
    await screenshot(page, 'issue-31-assistant-ready.png');

    await page.locator('[data-intake-row="' + convertWorkflowItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-bundle-id').selectOption(bundle.id);
    await page.locator('#intake-task-date').fill('2026-07-15');
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Convert to task' }).click();
    await expect(page).toHaveURL(new RegExp('#/bundles\\?bundleId=' + bundle.id + '&taskId='));
    await expect(page.locator('#bundle-detail')).toContainText('Inbox Workflow ' + suffix);
    await expect(page.locator('#bundle-tasks-table')).toContainText('Convert workflow intake ' + suffix);
    await expect(page.locator('#bundle-tasks-table .task-target-row')).toContainText('Convert workflow intake ' + suffix);
    await screenshot(page, 'issue-63-convert-workflow-task-destination.png');

    await page.goto('/#/inbox');
    await page.locator('[data-intake-row="' + convertAdhocItem.id + '"] [data-intake-select]').click();
    await page.locator('#intake-task-date').fill('2026-07-16');
    await page.locator('[data-testid="inbox-detail"]').getByRole('button', { name: 'Convert to task' }).click();
    await expect(page).toHaveURL(/#\/tasks\?taskId=/);
    await expect(page.locator('#tasks-table')).toContainText('Convert adhoc intake ' + suffix);
    await expect(page.locator('#tasks-table .task-target-row')).toContainText('Convert adhoc intake ' + suffix);
    await screenshot(page, 'issue-63-convert-adhoc-task-destination.png');

    await page.goto('/#/inbox');
    await page.locator('[data-intake-filter="actionable"]').click();
    await expect(page.locator('[data-intake-row="' + attachTaskItem.id + '"]')).toHaveCount(0);
    await expect(page.locator('[data-intake-row="' + attachAdhocTaskWorkflowItem.id + '"]')).toHaveCount(0);
    await expect(page.locator('[data-intake-row="' + attachWorkflowItem.id + '"]')).toHaveCount(0);
    await expect(page.locator('[data-intake-row="' + convertWorkflowItem.id + '"]')).toHaveCount(0);
    await expect(page.locator('[data-intake-row="' + convertAdhocItem.id + '"]')).toHaveCount(0);
    await page.locator('[data-intake-filter="resolved"]').click();
    await expect(page.locator('[data-intake-row="' + attachTaskItem.id + '"]')).toBeVisible();
    await expect(page.locator('[data-intake-row="' + attachAdhocTaskWorkflowItem.id + '"]')).toBeVisible();
    await expect(page.locator('[data-intake-row="' + attachWorkflowItem.id + '"]')).toBeVisible();
    await expect(page.locator('[data-intake-row="' + convertWorkflowItem.id + '"]')).toBeVisible();
    await expect(page.locator('[data-intake-row="' + convertAdhocItem.id + '"]')).toBeVisible();
  });
});
