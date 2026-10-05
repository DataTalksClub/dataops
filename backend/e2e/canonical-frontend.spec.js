const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const SHOTS = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots');

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe('canonical DataOps frontend', () => {
  test('resolves legacy hash routes inside one navigation shell', async ({ page, request }) => {
    await page.goto('/#/');
    await expect(page.locator('#document-list')).toBeVisible();
    await expect(page.locator('button[data-workspace-view="home"]')).toHaveAttribute('aria-current', 'page');

    await page.goto('/#/cards');
    await expect(page.getByRole('heading', { name: 'Cards', exact: true })).toBeVisible();
    await expect(page.locator('[data-tasks-section="workflows"]')).toHaveAttribute('aria-current', 'page');

    await page.goto('/#/recurring');
    await expect(page.getByRole('heading', { name: 'Recurring', exact: true })).toBeVisible();
    await expect(page.locator('[data-tasks-section="recurring"]')).toHaveAttribute('aria-current', 'page');

    await page.goto('/#/notifications');
    await expect(page.locator('#work-bell-panel')).toBeVisible();

    expect((await request.get('/public/app.js')).status()).toBe(404);
    expect((await request.get('/public/api.js')).status()).toBe(404);
  });

  test('opens task and workflow entity deep links in canonical panels', async ({ page, request }) => {
    const id = suffix();
    const cardResponse = await request.post('/api/cards', {
      data: { title: `Canonical workflow ${id}`, anchorDate: '2026-08-11' },
    });
    expect(cardResponse.status()).toBe(201);
    const card = (await cardResponse.json()).card;
    const taskResponse = await request.post('/api/tasks', {
      data: { description: `Canonical task ${id}`, date: '2026-08-11', cardId: card.id },
    });
    expect(taskResponse.status()).toBe(201);
    const task = await taskResponse.json();

    await page.goto(`/#/cards?cardId=${card.id}`);
    await expect(page.locator('#card-panel')).toBeVisible();
    await expect(page.locator('#card-panel-title')).toContainText(`Canonical workflow ${id}`);

    await page.goto(`/#/tasks?taskId=${task.id}`);
    await expect(page.locator('#task-panel')).toBeVisible();
    await expect(page.locator('#task-panel-title')).toContainText(`Canonical task ${id}`);
  });

  test('runs and reviews an assistant job from the canonical lifecycle UI', async ({ page, request }) => {
    const id = suffix();
    const cardResponse = await request.post('/api/cards', {
      data: { title: `Assistant workflow ${id}`, anchorDate: '2026-08-11' },
    });
    const card = (await cardResponse.json()).card;
    const jobResponse = await request.post('/api/assistant-jobs', {
      data: {
        assistantType: 'podcast',
        title: `Canonical assistant ${id}`,
        cardId: card.id,
        inputRefs: [{ type: 'card', id: card.id }],
        approvalRequired: true,
        maxAttempts: 2,
      },
    });
    expect(jobResponse.status()).toBe(201);
    const job = (await jobResponse.json()).job;

    await page.goto(`/#/assistants?assistantJobId=${job.id}`);
    await expect(page.getByRole('heading', { name: 'Assistants', exact: true })).toBeVisible();
    await expect(page.locator('.assistant-detail h3')).toHaveText(`Canonical assistant ${id}`);
    await expect(page.locator('[data-assistant-save]')).toBeVisible();
    await expect(page.locator('[data-assistant-lifecycle="submit"]')).toBeVisible();
    await page.locator('[data-assistant-lifecycle="run-dry"]').click();
    await expect(page.locator('.assistant-artifacts a')).toHaveCount(1);
    await expect(page.locator('[data-assistant-lifecycle="approve"]')).toBeVisible();
  });

  test('inspects the database-backed Git projection without mutation controls', async ({ page }) => {
    await page.goto('/#/templates');
    const row = page.locator('.runtime-template-row', { hasText: 'Synthetic Git-authored workflow' });
    await expect(row).toBeVisible();
    await row.click();
    const projection = page.locator('.runtime-template-projection');
    await expect(projection).toContainText('workflow-templates/synthetic-git-workflow.yaml');
    await expect(projection).toContainText('0123456789ab');
    await expect(projection.getByRole('button', { name: 'Create card' })).toBeVisible();
    await expect(page.getByRole('button', { name: /template/i }).filter({ hasText: /new|save|delete/i })).toHaveCount(0);
  });
});
