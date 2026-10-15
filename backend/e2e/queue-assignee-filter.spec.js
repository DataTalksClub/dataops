// Queue assignee scope: /tasks opens on the signed-in operator's own work,
// and the Assignee select moves between Mine, a teammate, Unassigned and All
// through the URL, so Back/Forward and shared links carry the scope.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const VALERIIA_ID = '00000000-0000-0000-0000-000000000002';
const MINE = 'Synthetic assignee task for Grace';
const THEIRS = 'Synthetic assignee task for Valeriia';
const screenshots = process.env.QUEUE_FILTER_SHOT_DIR || '';

let server;

test.describe.configure({ mode: 'serial' });

async function api(method, route, body) {
  const response = await fetch(`${server.baseURL}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(response.ok, `${method} ${route} ${response.status}`).toBeTruthy();
  return response.status === 204 ? null : response.json();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('queue-assignee-filter') },
  });
  // The API actor is Grace, the same operator the browser signs in as.
  await api('POST', '/api/tasks', { description: MINE, date: today() });
  await api('POST', '/api/tasks', { description: THEIRS, date: today(), assigneeId: VALERIIA_ID });
});

test.afterAll(async () => stopOwnedTestServer(server));

function row(page, title) {
  return page.locator('.ops-queue-row', { hasText: title });
}

test('opens on Mine, switches to a teammate and All, and round-trips through the URL', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks`);
  const filter = page.getByRole('combobox', { name: 'Filter queue by assignee' });
  await expect(row(page, MINE)).toBeVisible({ timeout: 20000 });
  await expect(filter).toHaveValue('me');
  await expect(row(page, THEIRS)).toHaveCount(0);
  await expect(page.locator('.ops-queue-total')).toContainText('assigned to you');
  expect(new URL(page.url()).search).toBe('');
  if (screenshots) {
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'queue-mine-desktop.png') });
  }

  await filter.selectOption(VALERIIA_ID);
  await expect(page).toHaveURL(`${server.baseURL}/tasks?assignee=${VALERIIA_ID}`);
  await expect(row(page, THEIRS)).toBeVisible();
  await expect(row(page, MINE)).toHaveCount(0);
  await expect(page.locator('.ops-queue-total')).toContainText('1 open assigned to Valeriia');

  await page.getByRole('combobox', { name: 'Filter queue by assignee' }).selectOption('all');
  await expect(page).toHaveURL(`${server.baseURL}/tasks?assignee=all`);
  await expect(row(page, MINE)).toBeVisible();
  await expect(row(page, THEIRS)).toBeVisible();

  // Back and Forward restore the scope the URL names.
  await page.goBack();
  await expect(page).toHaveURL(`${server.baseURL}/tasks?assignee=${VALERIIA_ID}`);
  await expect(filter).toHaveValue(VALERIIA_ID);
  await expect(row(page, MINE)).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(`${server.baseURL}/tasks`);
  await expect(filter).toHaveValue('me');
  await expect(row(page, THEIRS)).toHaveCount(0);
  await page.goForward();
  await expect(filter).toHaveValue(VALERIIA_ID);
  await expect(row(page, THEIRS)).toBeVisible();

  // A shared link opens straight on its scope; ?assignee=me is the bare URL.
  await page.goto(`${server.baseURL}/tasks?assignee=all`);
  await expect(filter).toHaveValue('all');
  await expect(row(page, THEIRS)).toBeVisible();
  await page.goto(`${server.baseURL}/tasks?assignee=me`);
  await expect(page).toHaveURL(`${server.baseURL}/tasks`);
  await expect(filter).toHaveValue('me');
  await expect(row(page, MINE)).toBeVisible();
});

test('opening a task keeps the scope, and closing it returns to the same scope', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks?assignee=${VALERIIA_ID}`);
  await row(page, THEIRS).locator('.ops-queue-main').click();
  await expect(page).toHaveURL(new RegExp(`assignee=${VALERIIA_ID}`));
  await expect(page).toHaveURL(/taskId=/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(`${server.baseURL}/tasks?assignee=${VALERIIA_ID}`);
  await expect(page.getByRole('combobox', { name: 'Filter queue by assignee' })).toHaveValue(VALERIIA_ID);
});

test('at 375px the Assignee select shares the toolbar without pushing the rows down', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks`);
  await expect(row(page, MINE)).toBeVisible({ timeout: 20000 });
  const filter = page.getByRole('combobox', { name: 'Filter queue by assignee' });
  const box = await filter.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(375 - 16 + 1);
  const listTop = await page.locator('.ops-queue-board').evaluate((node) => node.getBoundingClientRect().top);
  expect(listTop).toBeLessThanOrEqual(Math.round(667 / 3) + 2);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'queue-mine-375.png') });
});
