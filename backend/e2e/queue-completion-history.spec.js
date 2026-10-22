const path = require('node:path');
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { loginAndSetupPage } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');
let server;
let task;
const title = 'Synthetic queue completion journey';
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot('queue-completion-history') } });
  const response = await fetch(`${server.baseURL}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: title, date: new Date().toISOString().slice(0, 10) }),
  });
  expect(response.ok).toBeTruthy();
  task = await response.json();
});
test.afterAll(async () => stopOwnedTestServer(server));

test('completion stays struck through, supports reopening, and survives reload in history', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await loginAndSetupPage(page, { get: route => page.request.get(`${server.baseURL}${route}`) });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${server.baseURL}/tasks?assignee=all`);
  const row = page.locator(`.ops-queue-row[data-task-id="${task.id}"]`);
  await expect(row).toBeVisible({ timeout: 15000 });
  const firstIndex = await row.evaluate((node) => [...node.parentNode.children].indexOf(node));
  await row.locator('.ops-queue-check').click();
  await expect(row).toHaveAttribute('data-completed', 'true');
  await expect(page.locator('.ops-queue-total')).toContainText(/0 actionable.*1 completed this session/);
  await expect(row.getByRole('checkbox')).toBeChecked();
  expect(await row.evaluate((node) => [...node.parentNode.children].indexOf(node))).toBe(firstIndex);
  await expect(row.locator('.ops-queue-title-row > strong')).toHaveCSS('text-decoration-line', /line-through/);
  await row.locator('.ops-queue-check').click();
  await expect(row).toHaveAttribute('data-completed', 'false');
  await expect(page.locator('.ops-queue-total')).toContainText('1 actionable');
  await expect(page.locator('.ops-queue-total')).not.toContainText('completed this session');
  await row.locator('.ops-queue-check').click();
  await expect(row).toHaveAttribute('data-completed', 'true');
  await expect(page.locator('.ops-queue-total')).toContainText(/0 actionable.*1 completed this session/);
  const shots = process.env.QUEUE_COMPLETION_SHOT_DIR;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'queue-completed-retained.png') });
  }
  await page.reload();
  await expect(page.locator('.ops-queue-board')).toBeVisible();
  await expect(row).toHaveCount(0);
  const history = page.locator('.ops-queue-history').filter({ has: page.locator('summary', { hasText: 'Completed history' }) });
  await history.locator('summary').click();
  const historyRow = history.locator(`.ops-queue-history-row[data-task-id="${task.id}"]`);
  await expect(historyRow).toBeVisible();
  await historyRow.click();
  await expect(page).toHaveURL(new RegExp(`taskId=${task.id}`));
  await expect(page.getByRole('dialog')).toBeVisible();
  if (shots) await page.screenshot({ path: path.join(shots, 'queue-completed-history-detail.png') });
  expect(errors).toEqual([]);
});
