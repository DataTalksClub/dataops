// Finishing a Task (Skip with a reason, or Mark done) closes its dialog and
// returns the operator to where they opened it: the queue, without the Task
// and with its count updated, or the Card dialog, with the checklist showing
// the change. A dependent the finished Task was holding back joins the queue.
const { test, expect } = require('@playwright/test');
const { emptyTemplateId } = require('./helpers/card-template');
const { berlinBusinessDate } = require('./helpers/business-date');
const { setupPageWithAuth } = require('./helpers/auth');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const { startOwnedTestServer, stopOwnedTestServer } = require('./helpers/isolated-capability-server');

// An owned server: the queue holds only this spec's Tasks, so none of them
// falls past the queue's visible cap behind other specs' work.
let server;
const at = (path) => `${server.baseURL}${path}`;
test.beforeAll(async () => {
  server = await startOwnedTestServer({ environment: { DTC_CACHE_ROOT: createDocsCacheRoot(__filename.split('/').pop()) } });
});
test.afterAll(async () => stopOwnedTestServer(server));

async function json(response, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

const today = berlinBusinessDate(new Date());

async function seedCard(request, label) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { card } = await json(await request.post(at('/api/cards'), {
    data: { title: `Synthetic finish card ${label} ${unique}`, anchorDate: today, stage: 'announced', templateId: await emptyTemplateId(request, server.baseURL) },
  }), 201);
  const first = await json(await request.post(at('/api/tasks'), {
    data: { description: `Synthetic finish first ${label} ${unique}`, date: today, cardId: card.id },
  }), 201);
  const dependent = await json(await request.post(at('/api/tasks'), {
    data: { description: `Synthetic finish after ${label} ${unique}`, date: today, cardId: card.id, dependsOn: [first.id] },
  }), 201);
  return { card, first, dependent };
}

async function openCount(page) {
  const text = await page.locator('.ops-queue-total').textContent();
  return Number(/(\d+)\s+actionable/.exec(text)[1]);
}

async function scrollPosition(page) {
  return page.evaluate(() => document.scrollingElement.scrollTop + document.querySelector('#main-content').scrollTop);
}

test.describe('a finished Task returns to where it was opened', () => {
  test.beforeEach(async ({ page }) => setupPageWithAuth(page));

  test('Skip from the queue closes both dialogs, drops the row and the count, and releases its dependent', async ({ page, request }) => {
    const { first, dependent } = await seedCard(request, 'queue');
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto(at('/tasks?assignee=all'));
    const row = page.locator(`.ops-queue-row[data-task-id="${first.id}"]`);
    const dependentRow = page.locator(`.ops-queue-row[data-task-id="${dependent.id}"]`);
    await expect(row).toBeVisible({ timeout: 20000 });
    // Waiting on the first Task, the dependent is not in the queue yet.
    await expect(dependentRow).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    const scrollBefore = await scrollPosition(page);
    const countBefore = await openCount(page);

    await row.locator('.ops-queue-main').click();
    await expect(page).toHaveURL(at(`/tasks?taskId=${first.id}&assignee=all`));
    await page.locator('#task-panel').getByRole('button', { name: 'Skip…' }).click();
    const dialog = page.locator('dialog[data-work-dialog="skip-task"]');
    await dialog.getByLabel('Why are you skipping this?').fill('Synthetic: does not apply');
    // Hold the list reads the refresh makes: the queue changes from the skip
    // response itself, before any re-read.
    let releaseLists;
    const listsHeld = new Promise((resolve) => { releaseLists = resolve; });
    await page.route(/\/api\/tasks\?/, async (route) => {
      await listsHeld;
      await route.continue();
    });
    await dialog.getByRole('button', { name: 'Skip task' }).click();
    await expect(row).toHaveCount(0);
    await expect(dependentRow).toHaveCount(1);
    releaseLists();

    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#task-panel')).toBeHidden();
    await expect(page).toHaveURL(at('/tasks?assignee=all'));
    await expect(row).toHaveCount(0);
    // One left, one released: the skipped prerequisite no longer holds it.
    await expect(dependentRow).toBeVisible();
    expect(await openCount(page)).toBe(countBefore);
    expect(await scrollPosition(page)).toBe(scrollBefore);
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    expect((await json(await request.get(at(`/api/tasks/${first.id}`)))).status).toBe('skipped');
  });

  test('Done from the queue drops the row and the count by one', async ({ page, request }) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const task = await json(await request.post(at('/api/tasks'), {
      data: { description: `Synthetic finish lone ${unique}`, date: today },
    }), 201);
    await page.goto(at('/tasks?assignee=all'));
    const row = page.locator(`.ops-queue-row[data-task-id="${task.id}"]`);
    await expect(row).toBeVisible({ timeout: 20000 });
    const countBefore = await openCount(page);

    await row.locator('.ops-queue-main').click();
    await page.locator('#task-panel').getByRole('button', { name: 'Mark done' }).click();
    await expect(page.locator('#task-panel')).toBeHidden();
    await expect(page).toHaveURL(at('/tasks?assignee=all'));
    await expect(row).toHaveCount(0);
    await expect.poll(() => openCount(page)).toBe(countBefore - 1);
  });

  test('Skip and Done inside a Card dialog return to the Card, which shows the change', async ({ page, request }) => {
    const { card, first, dependent } = await seedCard(request, 'card');
    await page.goto(at('/tasks?assignee=all'));
    const row = page.locator(`.ops-queue-row[data-task-id="${first.id}"]`);
    await expect(row).toBeVisible({ timeout: 20000 });
    await row.locator('.ops-queue-origin-link').click();
    const cardDialog = page.locator('#card-panel');
    await expect(cardDialog).toBeVisible();

    await cardDialog.locator('.card-checklist-label', { hasText: first.description }).click();
    await page.locator('#task-panel').getByRole('button', { name: 'Skip…' }).click();
    const dialog = page.locator('dialog[data-work-dialog="skip-task"]');
    await dialog.getByLabel('Why are you skipping this?').fill('Synthetic: not this time');
    await dialog.getByRole('button', { name: 'Skip task' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#task-panel')).toBeHidden();
    await expect(cardDialog).toBeVisible();
    await expect(page).toHaveURL(at(`/tasks?assignee=all&card=${card.id}`));
    await expect(cardDialog.locator('.card-checklist-label.is-skipped', { hasText: first.description })).toBeVisible();
    await expect(cardDialog.locator('.card-checklist-label', { hasText: first.description })).toBeFocused();

    await cardDialog.locator('.card-checklist-label', { hasText: dependent.description }).click();
    await page.locator('#task-panel').getByRole('button', { name: 'Mark done' }).click();
    await expect(page.locator('#task-panel')).toBeHidden();
    await expect(cardDialog).toBeVisible();
    await expect(cardDialog.locator('.card-checklist-label.is-done', { hasText: dependent.description })).toBeVisible();

    await page.locator('#card-panel-close').click();
    await expect(page).toHaveURL(at('/tasks?assignee=all'));
    await expect(row).toHaveCount(0);
    await expect(page.locator(`.ops-queue-row[data-task-id="${dependent.id}"]`)).toHaveCount(0);
  });
});
