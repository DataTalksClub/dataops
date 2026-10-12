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
    const definitionDetails = page.locator('.runtime-template-provenance');
    await expect(definitionDetails).toHaveJSProperty('open', false);
    await expect(page.getByText('workflow-templates/synthetic-git-workflow.yaml')).toBeHidden();
    await definitionDetails.getByText('Definition details', { exact: true }).click();
    await expect(page.getByText('workflow-templates/synthetic-git-workflow.yaml')).toBeVisible();
    await expect(page.getByText('0123456789ab')).toBeVisible();
    await expect(page.getByText('This definition is projected from reviewed YAML.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New runtime template' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save template' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete template' })).toHaveCount(0);

    await page.locator('.runtime-template-projection').getByRole('button', { name: 'Start card' }).click();
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

for (const [width, height] of [[1440, 900], [1280, 800], [375, 667], [390, 844]]) {
  test(`template preview guidance and Start card at ${width}x${height}`, async ({ page }) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const out = path.resolve(__dirname, '../../.tmp/demo-c-after');
    fs.mkdirSync(out, { recursive: true });
    await page.setViewportSize({ width, height });
    await page.goto('/#/templates');
    const empty = page.locator('.runtime-template-empty');
    await expect(empty).toContainText('Choose a template');
    await expect(empty).toContainText('Use Start card');
    await expect(page.locator('.runtime-template-row-open')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start card', exact: true })).toHaveCount(0);
    if (width > 1000) {
      const listBox = await page.locator('.runtime-template-list').boundingBox();
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
