const { test, expect } = require('@playwright/test');
const { recordCapabilityEvidence } = require('./helpers/capability-evidence');

test.describe('Git-authored runtime templates', () => {
  test('keeps Git-authored templates read-only and creates cards from their deployed projections', async ({ page, request }, testInfo) => {
    const list = await request.get('/api/templates');
    expect(list.status()).toBe(200);
    const templates = (await list.json()).templates;
    const template = templates.find((item) => item.type === 'synthetic-git-workflow');
    expect(template).toBeTruthy();

    for (const [method, path, data] of [
      ['post', '/api/templates', { name: 'Must not persist' }],
      ['put', `/api/templates/${template.id}`, { name: 'Must not persist' }],
      ['delete', `/api/templates/${template.id}`, {}],
    ]) {
      const response = await request[method](path, { data });
      expect(response.status()).toBe(405);
      expect((await response.json()).authority).toBe('git-authored-workflow-templates');
    }

    await page.goto(`/#/templates?templateId=${encodeURIComponent(template.id)}`);
    await expect(page.getByRole('heading', { name: /Synthetic Git-authored workflow/ })).toBeVisible();
    await expect(page.getByText('workflow-templates/synthetic-git-workflow.yaml')).toBeVisible();
    await expect(page.getByText('0123456789ab')).toBeVisible();
    await expect(page.getByText(/private knowledge repository/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'New runtime template' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save template' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete template' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Create card' }).click();
    const form = page.locator('.quick-form-overlay');
    await expect(form.locator('.quick-form-select')).toHaveValue(template.id);
    await form.getByLabel('Card title (optional)').fill('Synthetic projection card');
    const createdResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/api/cards')
    ));
    await form.getByRole('button', { name: 'Create card' }).click();
    expect((await createdResponse).status()).toBe(201);
    recordCapabilityEvidence(testInfo, [{
      route: '/#/templates?templateId=<id>',
      roleId: 'admin',
      stateIds: ['templates.read-only', 'templates.source-revision', 'templates.create-card', 'templates.method-not-allowed'],
    }]);
  });

  test('keeps template failures and stale deep links honest', async ({ page, request }, testInfo) => {
    await request.post('/__e2e__/route-faults', {
      data: { faults: [{ method: 'GET', path: '/api/templates', status: 503 }] },
    });
    await page.goto('/#/templates');
    await expect(page.getByText('Runtime templates unavailable')).toBeVisible();
    await expect(page.locator('.runtime-template-inspector')).toContainText('Synthetic route failure (503)');
    // The Templates section also states its own load outcome (#204 slice 1).
    const templatesSummary = page.locator('[data-summary-id="tasks-templates"]');
    await expect(templatesSummary).toHaveAttribute('data-summary-state', /partial|unavailable/);
    await expect(templatesSummary.locator('.surface-summary-detail')).toHaveText('Synthetic route failure (503)');
    await request.delete('/__e2e__/route-faults');

    await page.goto('/#/templates?templateId=missing-git-template');
    await expect(page.getByText(/template not found/i)).toBeVisible();
    recordCapabilityEvidence(testInfo, [{
      route: '/#/templates?templateId=<id>',
      roleId: 'admin',
      stateIds: ['templates.failure'],
    }]);
  });
});
