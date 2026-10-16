const { test, expect } = require('@playwright/test');
const { emptyTemplateId } = require('./helpers/card-template');

async function json(response, status = 200) {
  expect(response.status()).toBe(status);
  return response.json();
}

async function createCardWithTasks(request, title, descriptions) {
  const { card } = await json(await request.post('/api/cards', {
    data: { title, anchorDate: '2026-08-20', stage: 'announced', templateId: await emptyTemplateId(request) },
  }), 201);
  const tasks = [];
  for (const [index, description] of descriptions.entries()) {
    tasks.push(await json(await request.post('/api/tasks', {
      data: {
        description,
        date: '2026-08-20',
        cardId: card.id,
        ...(index === descriptions.length - 1 ? { requiredLinkName: 'Recording' } : {}),
      },
    }), 201));
  }
  return { card, tasks };
}

test.describe('skip a Task and delete a Card', () => {
  test('skips a gated Task with a reason, completes its Card, and unskips it', async ({ page, request }) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { card, tasks: [first, gated] } = await createCardWithTasks(
      request,
      `Synthetic skip card ${unique}`,
      [`Synthetic finished step ${unique}`, `Synthetic gated step ${unique}`],
    );
    await json(await request.put(`/api/tasks/${first.id}`, {
      data: { status: 'done', expectedVersion: first.version },
    }));

    await page.goto(`/cards?cardId=${card.id}&taskId=${gated.id}`);
    const panel = page.locator('#task-panel');
    await expect(page.locator('#task-panel-title')).toContainText(`Synthetic gated step ${unique}`);
    await panel.getByRole('button', { name: 'Skip…' }).click();

    const dialog = page.locator('dialog[data-work-dialog="skip-task"]');
    await expect(dialog).toBeVisible();
    // Nothing to confirm until there is a reason.
    await expect(dialog.getByRole('button', { name: 'Skip task' })).toBeDisabled();
    await dialog.getByLabel('Why are you skipping this?').fill('   ');
    await expect(dialog.getByRole('button', { name: 'Skip task' })).toBeDisabled();
    await dialog.getByLabel('Why are you skipping this?').fill('Self-hosted event, no recording');
    await dialog.getByRole('button', { name: 'Skip task' }).click();
    await expect(dialog).toHaveCount(0);

    // A skipped Task is finished: its dialog closes back to the Card, whose
    // checklist shows the skip and its reason.
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(`/cards?cardId=${card.id}`);
    const cardPanel = page.locator('#card-panel');
    const gatedLabel = cardPanel.locator('.card-checklist-label', { hasText: `Synthetic gated step ${unique}` });
    await expect(gatedLabel).toHaveClass(/is-skipped/);
    await expect(cardPanel).toContainText('Self-hosted event, no recording');
    const skipped = await json(await request.get(`/api/tasks/${gated.id}`));
    expect(skipped).toMatchObject({ status: 'skipped', skipReason: 'Self-hosted event, no recording' });
    expect(skipped.taskHistory.at(-1)).toMatchObject({ action: 'skipped', note: 'Self-hosted event, no recording' });
    const completed = (await json(await request.get(`/api/cards/${card.id}`))).card;
    expect(completed).toMatchObject({ status: 'archived', stage: 'done', openTaskCount: 0 });

    await gatedLabel.click();
    await expect(panel).toContainText('Skipped: not applicable');
    await panel.getByRole('button', { name: 'Unskip' }).click();
    await expect(panel.getByRole('button', { name: 'Skip…' })).toBeVisible();
    const reopened = await json(await request.get(`/api/tasks/${gated.id}`));
    expect(reopened.status).toBe('todo');
    expect(reopened.skipReason).toBeUndefined();
    const reactivated = (await json(await request.get(`/api/cards/${card.id}`))).card;
    expect(reactivated).toMatchObject({ status: 'active', stage: 'announced', openTaskCount: 1 });
  });

  test('an admin deletes a Card and its Tasks after a confirm that names them', async ({ page, request }) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { card, tasks } = await createCardWithTasks(
      request,
      `Synthetic duplicate card ${unique}`,
      [`Synthetic duplicate step one ${unique}`, `Synthetic duplicate step two ${unique}`],
    );

    await page.goto(`/cards?cardId=${card.id}`);
    const cardPanel = page.locator('#card-panel');
    await expect(cardPanel).toBeVisible();
    await cardPanel.getByRole('button', { name: 'More card actions' }).click();
    await cardPanel.getByRole('menuitem', { name: 'Delete card…' }).click();

    const dialog = page.locator('dialog[data-work-dialog="delete-card"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Synthetic duplicate card ${unique}`);
    await expect(dialog).toContainText('its 2 tasks');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await request.get(`/api/cards/${card.id}`)).status()).toBe(200);

    await cardPanel.getByRole('button', { name: 'More card actions' }).click();
    await cardPanel.getByRole('menuitem', { name: 'Delete card…' }).click();
    await page.locator('dialog[data-work-dialog="delete-card"]').getByRole('button', { name: 'Delete card' }).click();
    await expect(page.locator('dialog[data-work-dialog="delete-card"]')).toHaveCount(0);
    await expect(page).toHaveURL(/\/cards$/);

    expect((await request.get(`/api/cards/${card.id}`)).status()).toBe(404);
    for (const task of tasks) {
      expect((await request.get(`/api/tasks/${task.id}`)).status()).toBe(404);
    }
  });
});
