const { test, expect } = require('@playwright/test');

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe('canonical DataOps frontend', () => {
  test('resolves legacy hash routes inside one navigation shell', async ({ page, request }) => {
    await page.goto('/#/');
    await expect(page.locator('#document-list')).toBeVisible();
    await expect(page.locator('[data-workspace-view="home"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-workspace-view="inbox"]')).toBeVisible();

    await page.goto('/#/bundles');
    await expect(page.locator('#library-title')).toHaveText('Tasks - Workflows');
    await expect(page.locator('[data-tasks-section="workflows"]')).toHaveAttribute('aria-current', 'page');

    await page.goto('/#/recurring');
    await expect(page.locator('#library-title')).toHaveText('Tasks - Templates');
    await expect(page.locator('[data-tasks-section="templates"]')).toHaveAttribute('aria-current', 'page');

    await page.goto('/#/notifications');
    await expect(page.locator('#work-bell-panel')).toBeVisible();

    expect((await request.get('/public/app.js')).status()).toBe(404);
    expect((await request.get('/public/api.js')).status()).toBe(404);
  });

  test('opens task and workflow entity deep links in canonical panels', async ({ page, request }) => {
    const id = suffix();
    const bundleResponse = await request.post('/api/bundles', {
      data: { title: `Canonical workflow ${id}`, anchorDate: '2026-08-11' },
    });
    expect(bundleResponse.status()).toBe(201);
    const bundle = (await bundleResponse.json()).bundle;
    const taskResponse = await request.post('/api/tasks', {
      data: { description: `Canonical task ${id}`, date: '2026-08-11', bundleId: bundle.id },
    });
    expect(taskResponse.status()).toBe(201);
    const task = await taskResponse.json();

    await page.goto(`/#/bundles?bundleId=${bundle.id}`);
    await expect(page.locator('#bundle-panel')).toBeVisible();
    await expect(page.locator('#bundle-panel-title')).toContainText(`Canonical workflow ${id}`);

    await page.goto(`/#/tasks?taskId=${task.id}`);
    await expect(page.locator('#task-panel')).toBeVisible();
    await expect(page.locator('#task-panel-title')).toContainText(`Canonical task ${id}`);
  });

  test('captures and triages Inbox items in the canonical surface', async ({ page, request }) => {
    const id = suffix();
    const response = await request.post('/api/intake', {
      data: { source: 'manual', title: `Canonical intake ${id}`, note: 'Safe synthetic intake context', dataClass: 'internal' },
    });
    expect(response.status()).toBe(201);
    const item = await response.json();

    await page.goto(`/#/inbox?intakeId=${item.id}`);
    await expect(page.locator('#library-title')).toHaveText('Inbox');
    await expect(page.locator('.intake-detail h3')).toHaveText(`Canonical intake ${id}`);
    await expect(page.locator('[data-intake-action="convert-task"]')).toBeVisible();
    await expect(page.locator('[data-intake-action="follow-up-sent"]')).toBeVisible();
    await expect(page.locator('[data-intake-action="prepare-assistant"]')).toBeVisible();
    await expect(page.locator('[data-intake-action="archive"]')).toBeVisible();

    await page.locator('[data-intake-waiting]').fill('Synthetic external response');
    await page.locator('[data-intake-followup]').fill('2026-08-14');
    await page.locator('[data-intake-reason]').fill('Waiting for a safe synthetic response');
    await page.locator('[data-intake-action="block"]').click();
    await expect(page.locator('.intake-status')).toContainText('blocked');
  });

  test('runs and reviews an assistant job from the canonical lifecycle UI', async ({ page, request }) => {
    const id = suffix();
    const bundleResponse = await request.post('/api/bundles', {
      data: { title: `Assistant workflow ${id}`, anchorDate: '2026-08-11' },
    });
    const bundle = (await bundleResponse.json()).bundle;
    const jobResponse = await request.post('/api/assistant-jobs', {
      data: {
        assistantType: 'podcast',
        title: `Canonical assistant ${id}`,
        bundleId: bundle.id,
        inputRefs: [{ type: 'bundle', id: bundle.id }],
        approvalRequired: true,
        maxAttempts: 2,
      },
    });
    expect(jobResponse.status()).toBe(201);
    const job = (await jobResponse.json()).job;

    await page.goto(`/#/assistants?assistantJobId=${job.id}`);
    await expect(page.locator('#library-title')).toHaveText('Tasks - Assistants');
    await expect(page.locator('.assistant-detail h3')).toHaveText(`Canonical assistant ${id}`);
    await expect(page.locator('[data-assistant-save]')).toBeVisible();
    await expect(page.locator('[data-assistant-lifecycle="submit"]')).toBeVisible();
    await page.locator('[data-assistant-lifecycle="run-dry"]').click();
    await expect(page.locator('.assistant-artifacts a')).toHaveCount(1);
    await expect(page.locator('[data-assistant-lifecycle="approve"]')).toBeVisible();
  });

  test('creates and deletes a database-backed runtime template', async ({ page }) => {
    const id = suffix();
    await page.goto('/#/templates');
    await expect(page.getByRole('button', { name: 'New runtime template' })).toBeVisible();
    await page.getByRole('button', { name: 'New runtime template' }).click();
    await page.getByLabel('Name').fill(`Canonical template ${id}`);
    await page.getByLabel('Source document IDs').fill('synthetic-process-doc');
    await page.getByLabel('Description').fill('Synthetic canonical task');
    await page.getByLabel('Proof type').selectOption('comment');
    await page.getByLabel('Proof label').fill('Completion note');
    await expect(page.locator('.runtime-template-json')).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.locator('.runtime-template-row', { hasText: `Canonical template ${id}` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete template' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete template' }).click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-ok').click();
    await expect(page.locator('.runtime-template-row', { hasText: `Canonical template ${id}` })).toHaveCount(0);
  });
});
