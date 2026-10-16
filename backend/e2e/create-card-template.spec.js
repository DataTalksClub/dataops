// Every Card is instantiated from a Template: Create card refuses to submit
// without one, and a created Card opens linked to its Template with no
// "not created from a Template" state.
const { test, expect } = require('@playwright/test');

test('Create card requires a Template and opens the Card linked to it', async ({ page }) => {
  const posts = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/cards') posts.push(request);
  });
  await page.goto('/cards');
  await page.getByRole('button', { name: 'Create card', exact: true }).click();
  const form = page.locator('.quick-form-overlay');
  await expect(form.locator('.quick-form-select')).toBeEnabled();
  const title = `Synthetic templated Card ${Date.now()}`;
  await form.getByLabel('Card title').fill(title);

  await form.getByRole('button', { name: 'Create card' }).click();
  await expect(form).toContainText('Select a template.');
  expect(posts).toHaveLength(0);

  await form.locator('.quick-form-select').selectOption({ label: 'Synthetic Git-authored workflow' });
  const created = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/cards');
  await form.getByRole('button', { name: 'Create card' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().templateId).toBeTruthy();
  const { card, tasks } = await response.json();
  expect(card.templateVersion).toBeGreaterThanOrEqual(1);
  expect(card.templateDefinitionSnapshot.taskRefs).toEqual(['prepare-output']);
  expect(tasks.map((task) => task.templateTaskRef)).toEqual(['prepare-output']);

  const panel = page.locator('#card-panel');
  await expect(panel).toContainText('Template: Synthetic Git-authored workflow');
  await expect(panel).not.toContainText('not created from a Template');
  await expect(panel.getByRole('button', { name: 'Reload template status' })).toHaveCount(0);
});
