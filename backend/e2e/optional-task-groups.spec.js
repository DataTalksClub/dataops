const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

let server;
test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('optional-task-groups/docs-cache') },
  });
});
test.afterAll(async () => {
  await stopOwnedTestServer(server);
});

for (const includeOptional of [false, true]) {
  test(`quick Card creation ${includeOptional ? 'includes selected' : 'omits unchecked'} optional task groups`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: server.baseURL });
    const page = await context.newPage();
    const request = context.request;
    try {
      const fixture = await request.post('/__e2e__/template-fixtures', {
        data: {
          name: `Synthetic optional groups ${includeOptional}`,
          type: 'synthetic-optional-groups',
          sourcePath: `workflow-templates/synthetic-optional-groups-${includeOptional}.yaml`,
          sourceRevision: '1111111111111111111111111111111111111111',
          taskDefinitions: [
            { refId: 'core', description: 'Synthetic core step', offsetDays: 0 },
            { refId: 'secondary-a', description: 'Synthetic secondary prepare', offsetDays: 1, optionalGroup: 'secondary' },
            { refId: 'secondary-b', description: 'Synthetic secondary publish', offsetDays: 2, optionalGroup: 'secondary' },
          ],
        },
      });
      expect(fixture.status()).toBe(201);
      const { template } = await fixture.json();
      await page.goto(`/templates?templateId=${encodeURIComponent(template.id)}`);
      await page.locator('.runtime-template-projection').getByRole('button', { name: 'Start card' }).click();
      const form = page.locator('.quick-form-overlay');
      await expect(form.locator('.quick-form-select')).toHaveValue(template.id);
      const checkbox = form.getByRole('checkbox', { name: 'Include secondary tasks' });
      await expect(checkbox).not.toBeChecked();
      await expect(form.getByRole('checkbox')).toHaveCount(1);
      if (includeOptional) await checkbox.check();
      await form.getByLabel('Card title (optional)').fill(`Synthetic optional Card ${includeOptional}`);
      const pending = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/cards');
      await form.getByRole('button', { name: 'Create card' }).click();
      const response = await pending;
      expect(response.status()).toBe(201);
      const { card, tasks } = await response.json();
      expect(card.selectedOptionalGroups).toEqual(includeOptional ? ['secondary'] : []);
      expect(card.taskCount).toBe(includeOptional ? 3 : 1);
      expect(tasks.map(task => task.templateTaskRef)).toEqual(includeOptional
        ? ['core', 'secondary-a', 'secondary-b'] : ['core']);
      await expect(form).not.toBeVisible();
      const persisted = await request.get(`/api/cards/${card.id}`);
      expect(persisted.status()).toBe(200);
      expect((await persisted.json()).card.selectedOptionalGroups).toEqual(card.selectedOptionalGroups);

      if (!includeOptional) {
        const update = await request.put(`/__e2e__/template-fixtures/${template.id}`, {
          data: {
            sourceRevision: '2222222222222222222222222222222222222222',
            taskDefinitions: [
              ...template.taskDefinitions,
              { refId: 'secondary-c', description: 'Synthetic new secondary step', offsetDays: 3, optionalGroup: 'secondary' },
              { refId: 'new-core', description: 'Synthetic new required step', offsetDays: 3 },
            ],
          },
        });
        expect(update.status()).toBe(200);
        await page.goto(`/cards?cardId=${encodeURIComponent(card.id)}`);
        const panel = page.locator('#card-panel');
        await panel.getByRole('button', { name: 'Review template update' }).click();
        await expect(panel).toContainText('Add Synthetic new required step');
        await expect(panel).not.toContainText('Synthetic new secondary step');
        await panel.getByRole('button', { name: 'Apply reviewed update' }).click();
        await expect(panel).not.toContainText('Update available:');
        const persistedTasks = await request.get(`/api/tasks?cardId=${card.id}`);
        expect(persistedTasks.status()).toBe(200);
        expect((await persistedTasks.json()).tasks.map(task => task.templateTaskRef).sort()).toEqual(['core', 'new-core']);
      }
    } finally {
      await context.close();
    }
  });
}
