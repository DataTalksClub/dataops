// Task dependencies read quietly: a task waiting on a prerequisite has a
// dashed box, a muted "after X" line whose name opens X, and no urgency
// colour; the checklist never lists it above its prerequisite; the task
// dialog shows "Waiting on" and "Unblocks" only when there are edges.
const { test, expect } = require('@playwright/test');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

const FIRST = 'Synthetic edit and QA the transcript';
const SECOND = 'Synthetic prepare the reviewed transcript page';
const THIRD = 'Synthetic ask the guest to share the page';
const PLAIN = 'Synthetic upload the registrant emails';

let server;
let card;
const ids = {};

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

function isoDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  server = await startOwnedTestServer({
    environment: { DTC_CACHE_ROOT: createDocsCacheRoot('task-dependency-display') },
  });
  const { template } = await api('POST', '/__e2e__/template-fixtures', {
    name: 'Synthetic empty workflow', type: 'synthetic-empty', sourcePath: 'workflow-templates/synthetic-empty.yaml', taskDefinitions: [],
  });
  ({ card } = await api('POST', '/api/cards', {
    title: 'Synthetic dependency display episode', anchorDate: isoDate(10), stage: 'announced', templateId: template.id,
  }));
  ids.first = (await api('POST', '/api/tasks', { description: FIRST, date: isoDate(-1), cardId: card.id })).id;
  // Dated before its prerequisite and overdue: neither may show.
  ids.second = (await api('POST', '/api/tasks', {
    description: SECOND, date: isoDate(-2), cardId: card.id, dependsOn: [ids.first],
  })).id;
  ids.third = (await api('POST', '/api/tasks', {
    description: THIRD, date: isoDate(1), cardId: card.id, dependsOn: [ids.second],
  })).id;
  ids.plain = (await api('POST', '/api/tasks', { description: PLAIN, date: isoDate(2), cardId: card.id })).id;
});

test.afterAll(async () => stopOwnedTestServer(server));

test('queue: a waiting task is quiet and says what it is after', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks`);
  const row = (name) => page.locator('.ops-queue-row').filter({ has: page.locator('.ops-queue-main', { hasText: name }) });
  const waiting = row(SECOND);
  await expect(waiting).toBeVisible({ timeout: 20000 });
  await expect(waiting).toHaveAttribute('data-urgency', 'blocked');
  await expect(waiting.locator('.ops-queue-due')).not.toHaveAttribute('data-due', 'overdue');
  expect(await waiting.locator('.ops-queue-box').evaluate((node) => getComputedStyle(node).borderTopStyle)).toBe('dashed');
  const note = waiting.locator('.ops-queue-note');
  await expect(note).toHaveText(`after ${FIRST}`);
  // The title's accessible name is the task alone; the note describes it.
  const main = waiting.locator('.ops-queue-main');
  await expect(main).toHaveAccessibleName(`Open task ${SECOND}`);
  await expect(main).toHaveAccessibleDescription(`after ${FIRST}`);
  // The overdue prerequisite keeps its urgency.
  await expect(row(FIRST)).toHaveAttribute('data-urgency', 'overdue');

  await note.getByRole('link', { name: FIRST }).click();
  await expect(page.locator('#task-panel-title')).toContainText(FIRST);
});

test('card checklist: prerequisites first, after lines, no red on a waiting task', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/cards?cardId=${card.id}`);
  const rows = page.locator('#card-panel .card-checklist-item');
  await expect(rows).toHaveCount(4, { timeout: 20000 });
  await expect(rows.locator('.card-checklist-label')).toHaveText([FIRST, SECOND, THIRD, PLAIN]);
  const second = rows.nth(1);
  await expect(second).toHaveClass(/is-blocked/);
  await expect(second.locator('.card-checklist-after')).toHaveText(`after ${FIRST}`);
  await expect(second.locator('.card-checklist-day')).not.toHaveClass(/is-overdue/);
  await expect(rows.nth(0).locator('.card-checklist-day')).toHaveClass(/is-overdue/);
  // The title keeps its width: one line, not one word per line.
  const label = await second.locator('.card-checklist-label').boundingBox();
  expect(label.height).toBeLessThanOrEqual(24);
});

test('task dialog: Waiting on and Unblocks only when there are edges', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/cards?cardId=${card.id}&taskId=${ids.second}`);
  const panel = page.locator('#task-panel');
  await expect(page.locator('#task-panel-title')).toContainText(SECOND, { timeout: 20000 });
  await expect(panel.locator('.task-prerequisites .task-dependency-name')).toHaveText([FIRST]);
  await expect(panel.locator('.task-dependents .task-dependency-name')).toHaveText([THIRD]);
  await expect(panel.getByText('Waiting on 1 task above')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Mark done' })).toBeDisabled();

  await page.goto(`${server.baseURL}/cards?cardId=${card.id}&taskId=${ids.plain}`);
  await expect(page.locator('#task-panel-title')).toContainText(PLAIN, { timeout: 20000 });
  await expect(panel.locator('.task-dependency-section')).toHaveCount(0);
  await expect(panel).not.toContainText('Prerequisites');
  await panel.locator('.task-panel-more > summary').click();
  await expect(panel.locator('.task-panel-more .task-prerequisite-editor > summary')).toHaveText('Add a prerequisite');
});
