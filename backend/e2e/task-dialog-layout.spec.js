const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { loginAndSetupPage } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
let server, task, card;
async function api(method, route, body) {
  const response = await fetch(`${server.baseURL}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  expect(response.ok, `${method} ${route}: ${response.status} ${await response.clone().text()}`).toBeTruthy();
  return response.status === 204 ? null : response.json();
}
function isoDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}
// The waiting section only lists tasks whose follow-up is still ahead of
// today, so the fixture floats a few days out instead of naming a fixed date.
const TASK_DATE = isoDate(2);
const FOLLOW_UP_ISO = isoDate(5);
function dayMonthLabel(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  const short = `${date.getUTCDate()} ${date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
  return iso.slice(0, 4) === new Date().toISOString().slice(0, 4) ? short : `${short} ${iso.slice(0, 4)}`;
}
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('task-dialog-layout') } });
  const { template } = await api('POST', '/__e2e__/template-fixtures', { name: 'Synthetic newsletter', type: 'synthetic-newsletter', sourcePath: 'workflow-templates/synthetic-newsletter.yaml', taskDefinitions: [] });
  ({ card } = await api('POST', '/api/cards', { title: 'Newsletter sponsor · Example Company', anchorDate: isoDate(10), stage: 'announced', templateId: template.id }));
  task = await api('POST', '/api/tasks', { description: 'Prepare the sponsor invoice', date: TASK_DATE, cardId: card.id, status: 'waiting', waitingFor: 'Example Company: legal billing details requested in the existing thread', followUpAt: `${TASK_DATE}T09:00:00Z`, comment: 'Synthetic waiting fixture', requiresFile: true, assigneeId: '00000000-0000-0000-0000-000000000004' });
  task = await api('PUT', `/api/tasks/${task.id}`, { requires: ['finom'], browserRequirement: 'headless', expectedVersion: task.version });
});
test.afterAll(async () => stopOwnedTestServer(server));
for (const variant of [{ name: 'dark-desktop', width: 1280, height: 1000, theme: 'dark' }, { name: 'light-desktop', width: 1280, height: 1000, theme: 'light' }, { name: 'mobile', width: 390, height: 844, theme: 'dark' }]) {
  test(`task work sheet ${variant.name}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({width: variant.width, height: variant.height});
    await loginAndSetupPage(page, { get: route => page.request.get(`${server.baseURL}${route}`) });
    await page.goto(`${server.baseURL}/tasks?assignee=all`);
    await page.locator('.ops-queue-waiting > summary').click();
    const queueTask = page.locator('.ops-queue-waiting .ops-queue-row', { hasText: 'Prepare the sponsor invoice' });
    await expect(queueTask).toBeVisible();
    await queueTask.locator('.ops-queue-title-row').click();
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), variant.theme);
    const panel = page.locator('#task-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Example Company: legal billing details');
    await expect(panel.locator('.task-delegation-notice')).toContainText('Assigned to Orin');
    await expect(panel.locator('.task-context')).not.toContainText('Due');
    const context = panel.locator('.task-context');
    const action = panel.locator('.task-state-section');
    const setup = panel.locator('.task-setup');
    expect((await context.boundingBox()).y).toBeLessThan((await action.boundingBox()).y);
    expect((await action.boundingBox()).y).toBeLessThan((await setup.boundingBox()).y);
    await expect(panel.getByRole('button', { name: 'Response received', exact: true })).toBeVisible();
    await expect(panel.locator('[data-panel-field="follow-up-next"]')).toBeHidden();
    await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/screenshots/task-dialog', `${variant.name}.png`), fullPage: true });
    await panel.locator('.task-follow-up-disclosure > summary').focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByLabel('Next follow-up')).toBeVisible();
    await panel.getByLabel('Next follow-up').fill(FOLLOW_UP_ISO);
    await panel.getByRole('button', { name: 'Follow-up sent', exact: true }).click();
    await expect(panel).toContainText(dayMonthLabel(FOLLOW_UP_ISO));
    await panel.locator('.task-requires-edit').click();
    await expect(panel.locator('.task-requires-editor')).toBeAttached();
    await panel.locator('.task-requires-actions').getByRole('button', { name: 'Cancel' }).click();
    await panel.locator('.task-browser-edit').click();
    await expect(panel.locator('.task-browser-editor')).toBeAttached();
    await panel.locator('.task-browser-actions').getByRole('button', { name: 'Cancel' }).click();
    await panel.locator('.task-panel-more > summary').click();
    await expect(panel.locator('.task-history').filter({ hasText: 'History' }).last()).toBeVisible();
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBeTruthy();
    await panel.locator('#task-panel-close').click();
    await expect(panel).toBeHidden();
    expect(errors).toEqual([]);
  });
}
test('open and completed work keep their detail and evidence accessible', async ({ page }) => {
  await loginAndSetupPage(page, { get: route => page.request.get(`${server.baseURL}${route}`) });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${server.baseURL}/cards?cardId=${card.id}&taskId=${task.id}`);
  const panel = page.locator('#task-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Response received', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Mark done', exact: true })).toBeVisible();
  await expect(panel.locator('input[type="file"]')).toBeEnabled();
  await panel.locator('input[type="file"]').setInputFiles({ name: 'synthetic-invoice.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic invoice evidence') });
  await expect(panel).toContainText('synthetic-invoice.txt');
  await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/screenshots/task-dialog/open-desktop.png'), fullPage: true });
  const uploaded = await api('GET', `/api/tasks/${task.id}`);
  await api('PUT', `/api/tasks/${task.id}`, { status: 'done', expectedVersion: uploaded.version });
  await page.reload();
  await expect(panel.locator('.task-context')).toContainText('done');
  await panel.locator('.task-panel-more > summary').click();
  await expect(panel.locator('.task-history').filter({ hasText: 'History' }).last()).toContainText('Task completed');
  await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/screenshots/task-dialog/completed-desktop.png'), fullPage: true });
});
