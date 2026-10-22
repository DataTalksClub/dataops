const { test, expect } = require('@playwright/test');
const { recordCapabilityEvidence } = require('./helpers/capability-evidence');

test.describe('Git-authored runtime templates', () => {
  test('pins template step edits over the Git base and creates cards from the pin', async ({ page, request }, testInfo) => {
    const list = await request.get('/api/templates');
    expect(list.status()).toBe(200);
    const templates = (await list.json()).templates;
    const template = templates.find((item) => item.type === 'synthetic-git-workflow');
    expect(template).toBeTruthy();

    const patchResponse = await request.patch(`/api/templates/${template.id}`, { data: { name: 'Must not persist' } });
    expect(patchResponse.status()).toBe(405);

    const collectionDelete = await request.delete('/api/templates');
    expect(collectionDelete.status()).toBe(405);

    const deleteResponse = await request.delete(`/api/templates/${template.id}`, {
      data: { expectedVersion: template.version, revision: template.revision },
    });
    expect(deleteResponse.status()).toBe(409);
    expect((await deleteResponse.json()).code).toBe('cannot-delete-git-template');

    await page.goto(`/templates?templateId=${encodeURIComponent(template.id)}`);
    await expect(page.getByRole('heading', { name: /Synthetic Git-authored workflow/ })).toBeVisible();
    const definitionDetails = page.locator('.runtime-template-provenance');
    await expect(definitionDetails).toHaveJSProperty('open', false);
    await expect(page.getByText('workflow-templates/synthetic-git-workflow.yaml')).toBeHidden();
    await definitionDetails.getByText('Definition details', { exact: true }).click();
    await expect(page.getByText('workflow-templates/synthetic-git-workflow.yaml')).toBeVisible();
    await expect(page.getByText('0123456789ab')).toBeVisible();
    await expect(page.getByText(/Git seed lives in dataops-knowledge/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'New runtime template' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save template' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete template' })).toHaveCount(0);

    // Edit definition pins the effective definition: the save is a
    // compare-and-swap PUT carrying the fetched version pair, so a stale form
    // cannot overwrite a newer pin or Git base.
    const projection = page.locator('.runtime-template-projection');
    await projection.getByText('Edit definition (web)', { exact: true }).click();
    const editor = projection.locator('.runtime-template-editor');
    const textarea = editor.locator('textarea');
    const definition = JSON.parse(await textarea.inputValue());
    definition.taskDefinitions[0].description = 'Prepare a synthetic output (pinned)';
    await textarea.fill(JSON.stringify(definition, null, 2));
    const savedResponse = page.waitForResponse((response) => (
      response.request().method() === 'PUT'
      && new URL(response.url()).pathname.endsWith(`/api/templates/${template.id}`)
    ));
    await editor.getByRole('button', { name: 'Save pin' }).click();
    expect((await savedResponse).status()).toBe(200);
    await expect(editor.getByText(/Pinned synthetic-git-workflow to version/)).toBeVisible();

    await projection.getByRole('button', { name: 'Start card' }).click();
    const form = page.locator('.quick-form-overlay');
    await expect(form.locator('.quick-form-select')).toHaveValue(template.id);
    await form.getByLabel('Card title').fill('Synthetic pinned card');
    const createdResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/api/cards')
    ));
    await form.getByRole('button', { name: 'Create card' }).click();
    const createdReply = await createdResponse;
    expect(createdReply.status()).toBe(201);
    const created = await createdReply.json();
    const cardTasks = await (await request.get(`/api/tasks?cardId=${encodeURIComponent(created.card.id)}`)).json();
    expect(cardTasks.tasks.map((task) => task.description)).toContain('Prepare a synthetic output (pinned)');
    recordCapabilityEvidence(testInfo, [{
      route: '/templates?templateId=<id>',
      roleId: 'admin',
      stateIds: ['templates.read-only', 'templates.step-edits', 'templates.source-revision', 'templates.create-card', 'templates.method-not-allowed'],
    }]);
  });

  test('keeps template failures and stale deep links honest', async ({ page, request }, testInfo) => {
    await request.post('/__e2e__/route-faults', {
      data: { faults: [{ method: 'GET', path: '/api/templates', status: 503 }] },
    });
    await page.goto('/templates');
    await expect(page.getByText('Runtime templates unavailable')).toBeVisible();
    await expect(page.locator('.runtime-template-inspector')).toContainText('Synthetic route failure (503)');
    // The Templates section also states its own load outcome (#204 slice 1).
    const templatesSummary = page.locator('[data-summary-id="tasks-templates"]');
    await expect(templatesSummary).toHaveAttribute('data-summary-state', /partial|unavailable/);
    await expect(templatesSummary.locator('.surface-summary-detail')).toHaveText('Synthetic route failure (503)');
    await request.delete('/__e2e__/route-faults');

    await page.goto('/templates?templateId=missing-git-template');
    await expect(page.getByText(/template not found/i)).toBeVisible();
    recordCapabilityEvidence(testInfo, [{
      route: '/templates?templateId=<id>',
      roleId: 'admin',
      stateIds: ['templates.failure'],
    }]);
  });
});

for (const [width, height] of [[1440, 900], [1280, 800], [375, 667], [390, 844]]) {
  test(`template preview guidance and Start card at ${width}x${height}`, async ({ page }) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const out = path.resolve(__dirname, '../../.tmp/demo-c-after');
    fs.mkdirSync(out, { recursive: true });
    await page.setViewportSize({ width, height });
    await page.goto('/templates');
    const empty = page.locator('.runtime-template-projection .dk-split__empty');
    await expect(empty).toContainText('Choose a template');
    await expect(empty).toContainText('Use Start card');
    await expect(page.locator('.runtime-template-row-open')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start card', exact: true })).toHaveCount(0);
    if (width > 1000) {
      const listBox = await page.locator('.runtime-template-inspector .dk-split__list').boundingBox();
      const emptyBox = await empty.boundingBox();
      expect(emptyBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
    }
    await page.screenshot({ path: path.join(out, `templates-${width}x${height}.png`) });
    await page.locator('.runtime-template-row').first().click();
    await expect(page.locator('.runtime-template-projection').getByRole('button', { name: 'Start card' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start card', exact: true })).toHaveCount(1);
    await expect(page.locator('.runtime-template-projection').getByRole('button', { name: 'Create card' })).toHaveCount(0);
    await page.screenshot({ path: path.join(out, `template-detail-${width}x${height}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
