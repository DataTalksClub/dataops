// Task dependencies: on the card checklist a task waiting on a prerequisite
// has a dashed box, a muted unlock line and no urgency colour, and never
// sits above its prerequisite; the task dialog shows "Waiting on" and
// "Unblocks" only when there are edges, and names each blocking prerequisite
// beside Mark done as a button that opens it. The work queue lists
// actionable work first with a Waiting on other steps section, so
// assigned-but-blocked tasks stay visible with their unlock condition.
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
  // The unlock condition is named beside Mark done, and each blocker opens:
  // the button carries the blocking prerequisite's name and status.
  const why = panel.locator('[data-blocked="true"]');
  await expect(why).toContainText('Waiting on');
  await expect(why.getByRole('button', { name: FIRST })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Mark done' })).toBeDisabled();
  await why.getByRole('button', { name: FIRST }).click();
  await expect(page).toHaveURL(new RegExp(`taskId=${ids.first}`));

  await page.goto(`${server.baseURL}/cards?cardId=${card.id}&taskId=${ids.plain}`);
  await expect(page.locator('#task-panel-title')).toContainText(PLAIN, { timeout: 20000 });
  await expect(panel.locator('.task-dependency-section')).toHaveCount(0);
  await expect(panel).not.toContainText('Prerequisites');
  await panel.locator('.task-panel-more > summary').click();
  await expect(panel.locator('.task-panel-more .task-prerequisite-editor > summary')).toHaveText('Add a prerequisite');
});

// Last: it completes prerequisites, which the checklist and dialog tests
// above rely on being open.
test('queue: a waiting task stays out until its prerequisite is done', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupPageWithAuth(page);
  await page.goto(`${server.baseURL}/tasks?assignee=all`);
  const row = (name) => page.locator('.ops-queue-row').filter({ has: page.locator('.ops-queue-main', { hasText: name }) });
  const openRows = page.locator('.ops-queue-list .ops-queue-row');
  await expect(row(FIRST)).toBeVisible({ timeout: 20000 });
  await expect(row(FIRST)).toHaveAttribute('data-urgency', 'overdue');
  await expect(row(PLAIN)).toBeVisible();
  await expect(row(SECOND)).toHaveCount(0);
  await expect(row(THIRD)).toHaveCount(0);
  await expect(page.locator('.ops-queue-note', { hasText: /^after / })).toHaveCount(0);
  const total = page.locator('.ops-queue-total');
  const before = await openRows.count();
  await expect(total).toContainText(`${before} open`);

  // Completed elsewhere (another tab, the CLI): the next background refresh
  // brings the newly unblocked task in, still overdue, and the count follows.
  const first = await api('GET', `/api/tasks/${ids.first}`);
  await api('PUT', `/api/tasks/${ids.first}`, { status: 'done', expectedVersion: first.version });
  await page.evaluate(() => window.__dataopsRefreshWork());
  await expect(row(SECOND)).toBeVisible({ timeout: 20000 });
  await expect(row(SECOND)).toHaveAttribute('data-urgency', 'overdue');
  await expect(row(THIRD)).toHaveCount(0);
  await expect(total).toContainText(`${before} open`);

  // Ticked here: its own dependent joins the queue at once.
  await row(SECOND).locator('.ops-queue-check').click();
  await expect(row(THIRD)).toBeVisible({ timeout: 20000 });
  await expect(row(SECOND)).toHaveAttribute('data-completed', 'true');
  await page.reload();
  await expect(row(THIRD)).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.ops-queue-list').getByText(SECOND)).toHaveCount(0);
});
