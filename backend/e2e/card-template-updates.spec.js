const { test, expect } = require('@playwright/test');

async function json(response) {
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function createTemplate(request, name, taskDefinitions, extra = {}) {
  const response = await request.post('/__e2e__/template-fixtures', {
    data: {
      name,
      type: 'synthetic-template-update',
      sourcePath: `workflow-templates/${name.toLowerCase().replaceAll(' ', '-')}.yaml`,
      sourceRevision: '1111111111111111111111111111111111111111',
      taskDefinitions,
      ...extra,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).template;
}

async function createCard(request, templateId, title) {
  const response = await request.post('/api/cards', {
    data: {
      title,
      anchorDate: '2026-09-10',
      templateId,
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function updateTemplate(request, template, taskDefinitions) {
  const response = await request.put(`/__e2e__/template-fixtures/${template.id}`, {
    data: {
      sourceRevision: '2222222222222222222222222222222222222222',
      taskDefinitions,
    },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).template;
}

test.describe('reviewed Card Template updates', () => {
  test('cancels, survives a stale apply with typed input, then retains completed history', async ({ page, request }) => {
    const template = await createTemplate(request, 'Synthetic single update', [
      { refId: 'completed', description: 'Original completed step', offsetDays: -2 },
      { refId: 'removed', description: 'Remove this incomplete step', offsetDays: -1 },
    ], {
      cardLinkDefinitions: [{ name: 'Synthetic output' }],
    });
    const { card, tasks } = await createCard(request, template.id, 'Synthetic reviewed single Card');
    const completed = tasks.find(({ templateTaskRef }) => templateTaskRef === 'completed');
    const removed = tasks.find(({ templateTaskRef }) => templateTaskRef === 'removed');
    expect((await request.put(`/api/tasks/${completed.id}`, {
      data: { status: 'done', expectedVersion: completed.version },
    })).status()).toBe(200);
    await updateTemplate(request, template, [
      { refId: 'completed', description: 'Changed completed step', offsetDays: -2 },
      { refId: 'added', description: 'New reviewed step', offsetDays: 1 },
    ]);

    await page.goto(`/#/cards?cardId=${encodeURIComponent(card.id)}`);
    const panel = page.locator('#card-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Update available: Template v1 → v2');
    await panel.getByRole('button', { name: 'Review template update' }).click();
    await expect(panel).toContainText('Retain completed task: Changed completed step');
    await expect(panel).toContainText('Archive removed task: Remove this incomplete step');
    await expect(panel).toContainText('Add New reviewed step');
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel.getByRole('button', { name: 'Review template update' })).toBeVisible();

    await panel.getByRole('button', { name: 'Review template update' }).click();
    const draftReference = panel.locator('.card-ref-name');
    const draftReferenceUrl = panel.locator('.card-ref-url');
    await draftReference.fill('Public-safe typed reference');
    await draftReferenceUrl.fill('https://example.test/public-safe-draft');
    expect((await request.put(`/api/tasks/${removed.id}`, {
      data: {
        comment: 'Public-safe concurrent operator note',
        expectedVersion: removed.version,
      },
    })).status()).toBe(200);
    const staleApply = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith(`/api/cards/${card.id}/template-update`)
    ));
    await panel.getByRole('button', { name: 'Apply reviewed update' }).click();
    expect((await staleApply).status()).toBe(409);
    await expect(panel).toContainText('Your review is retained');
    await expect(draftReference).toHaveValue('Public-safe typed reference');
    await expect(draftReferenceUrl).toHaveValue('https://example.test/public-safe-draft');

    await panel.getByRole('button', { name: 'Reload latest preview' }).click();
    await expect(draftReference).toHaveValue('Public-safe typed reference');
    await expect(draftReferenceUrl).toHaveValue('https://example.test/public-safe-draft');
    await panel.getByRole('button', { name: 'Apply reviewed update' }).click();
    await expect(panel).toContainText('Current at Template v2');

    const appliedTasks = (await json(await request.get(`/api/tasks?cardId=${card.id}`))).tasks;
    expect(appliedTasks.find(({ id }) => id === completed.id)).toMatchObject({
      description: 'Original completed step',
      status: 'done',
      templateRetiredReason: 'completed-modified',
    });
    const retiredTask = appliedTasks.find(({ id }) => id === removed.id);
    expect(retiredTask).toMatchObject({
      status: 'archived',
      templateRetiredReason: 'removed',
    });
    expect(retiredTask.taskHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'template-retired',
      }),
    ]));
    expect(appliedTasks.find(({ templateTaskRef }) => templateTaskRef === 'added')).toMatchObject({
      description: 'New reviewed step',
      status: 'todo',
    });
  });

  test('applies an explicit batch and exposes one stale Card without retrying it', async ({ page, request }) => {
    const template = await createTemplate(request, 'Synthetic batch update', [
      { refId: 'prepare', description: 'Prepare original', offsetDays: -1 },
    ]);
    const first = await createCard(request, template.id, 'Synthetic batch Card A');
    const second = await createCard(request, template.id, 'Synthetic batch Card B');
    await updateTemplate(request, template, [
      { refId: 'prepare', description: 'Prepare reviewed', offsetDays: -1 },
      { refId: 'publish', description: 'Publish reviewed output', offsetDays: 1 },
    ]);

    await page.goto(`/#/templates?templateId=${encodeURIComponent(template.id)}`);
    const inspector = page.locator('.runtime-template-projection');
    await expect(inspector).toContainText('2 active Cards');
    await inspector.getByRole('button', { name: 'Review 2 Cards for updates' }).click();
    await expect(inspector).toContainText('Nothing is selected automatically');
    await expect(inspector.getByRole('button', { name: 'Apply 0 selected Cards' })).toBeDisabled();

    await expect(inspector.getByRole('checkbox', { name: 'Select Synthetic batch Card A' })).not.toBeChecked();
    await expect(inspector.getByRole('checkbox', { name: 'Select Synthetic batch Card B' })).not.toBeChecked();
    await inspector.getByRole('checkbox', { name: 'Select Synthetic batch Card A' }).check();
    await inspector.getByRole('checkbox', { name: 'Select Synthetic batch Card B' }).check();

    const staleTask = second.tasks.find(({ templateTaskRef }) => templateTaskRef === 'prepare');
    expect((await request.put(`/api/tasks/${staleTask.id}`, {
      data: {
        comment: 'Public-safe concurrent operator note',
        expectedVersion: staleTask.version,
      },
    })).status()).toBe(200);
    await inspector.getByRole('button', { name: 'Apply 2 selected Cards' }).click();
    await expect(inspector).toContainText('1 Card applied · 1 conflict needs a fresh preview');
    await expect(inspector).toContainText('Synthetic batch Card A: applied');
    await expect(inspector).toContainText('Synthetic batch Card B: conflict — reload before retrying');
    await expect(inspector.getByRole('button', { name: 'Reload batch previews' })).toBeVisible();

    const firstPreview = await json(await request.get(`/api/cards/${first.card.id}/template-update`));
    const secondPreview = await json(await request.get(`/api/cards/${second.card.id}/template-update`));
    expect(firstPreview.preview.state).toBe('current');
    expect(secondPreview.preview.state).toBe('update-available');
  });
});
