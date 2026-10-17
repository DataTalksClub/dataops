// A Card opens as a dialog over the page it was clicked on. The page stays as
// it was underneath (filters, scroll, focus), the address carries the open
// Card (`?card=`), and closing it — the close button, Escape or Back — leaves
// the operator where they were. A new tab still opens the Card's own page.
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

async function seedQueueCard(request, label) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { card } = await json(await request.post(at('/api/cards'), {
    data: { title: `Synthetic modal card ${label} ${unique}`, anchorDate: today, stage: 'announced', templateId: await emptyTemplateId(request, server.baseURL) },
  }), 201);
  const first = await json(await request.post(at('/api/tasks'), {
    data: { description: `Synthetic modal step one ${unique}`, date: today, cardId: card.id },
  }), 201);
  const second = await json(await request.post(at('/api/tasks'), {
    data: { description: `Synthetic modal step two ${unique}`, date: today, cardId: card.id },
  }), 201);
  return { card, first, second };
}

function queueRow(page, task) {
  return page.locator('.ops-queue-row', { hasText: task.description });
}

test.describe('card dialog over the current page', () => {
  test.beforeEach(async ({ page }) => setupPageWithAuth(page));

  test('Tasks: a Card opens over the queue and closing it keeps the filter, scroll and focus', async ({ page, request }) => {
    // Enough work above the Card's Task that the queue scrolls.
    for (let index = 0; index < 12; index += 1) {
      await json(await request.post(at('/api/tasks'), {
        data: { description: `Synthetic modal filler ${index}`, date: today },
      }), 201);
    }
    const { card, first } = await seedQueueCard(request, 'queue');
    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto(at('/tasks?assignee=all'));
    const row = queueRow(page, first);
    await expect(row).toBeVisible({ timeout: 20000 });
    const where = row.locator('.ops-queue-origin-link');
    // A new tab opens the Card's own page.
    await expect(where).toHaveAttribute('href', `/cards?cardId=${card.id}`);
    await row.scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => document.scrollingElement.scrollTop + document.querySelector('#main-content').scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);

    await where.click();
    const dialog = page.getByRole('dialog', { name: card.title });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(at(`/tasks?assignee=all&card=${card.id}`));
    await expect(page.locator('#card-panel-close')).toBeFocused();
    // The queue is still there underneath, inert.
    await expect(row).toBeAttached();
    expect(await page.locator('#document-list').evaluate((element) => Boolean(element.closest('[inert]')))).toBe(true);
    await expect(dialog.locator('.card-checklist-label', { hasText: first.description })).toBeVisible();

    await page.locator('#card-panel-close').click();
    await expect(page.locator('#card-panel')).toBeHidden();
    await expect(page).toHaveURL(at('/tasks?assignee=all'));
    await expect(page.locator('.ops-queue-row').first()).toBeVisible();
    await expect(where).toBeFocused();
    expect(await page.locator('#document-list').evaluate((element) => Boolean(element.closest('[inert]')))).toBe(false);
    const scrollAfter = await page.evaluate(() => document.scrollingElement.scrollTop + document.querySelector('#main-content').scrollTop);
    expect(scrollAfter).toBe(scrollBefore);
  });

  test('Back closes the Card and stays on the page; reload reopens it from the address', async ({ page, request }) => {
    const { card, first } = await seedQueueCard(request, 'history');
    await page.goto(at('/tasks?assignee=all'));
    const row = queueRow(page, first);
    await expect(row).toBeVisible({ timeout: 20000 });
    await row.locator('.ops-queue-origin-link').click();
    await expect(page.getByRole('dialog', { name: card.title })).toBeVisible();
    await expect(page).toHaveURL(at(`/tasks?assignee=all&card=${card.id}`));

    await page.reload();
    const dialog = page.getByRole('dialog', { name: card.title });
    await expect(dialog).toBeVisible({ timeout: 20000 });
    await expect(row).toBeAttached({ timeout: 20000 });
    await expect(page.locator('body')).toHaveAttribute('data-workspace-view', 'tasks');

    await page.goBack();
    await expect(page).toHaveURL(at('/tasks?assignee=all'));
    await expect(page.locator('#card-panel')).toBeHidden();
    await expect(row).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(at(`/tasks?assignee=all&card=${card.id}`));
    await expect(page.getByRole('dialog', { name: card.title })).toBeVisible();
  });

  test('a Task opened in the Card stacks over it; Escape closes the Task, then the Card', async ({ page, request }) => {
    const { card, first, second } = await seedQueueCard(request, 'stack');
    await page.goto(at('/tasks?assignee=all'));
    const row = queueRow(page, first);
    await expect(row).toBeVisible({ timeout: 20000 });
    await row.locator('.ops-queue-origin-link').click();
    const cardDialog = page.locator('#card-panel');
    const label = cardDialog.locator('.card-checklist-label', { hasText: second.description });
    await label.click();
    await expect(page.locator('#task-panel-title')).toContainText(second.description);
    await expect(page).toHaveURL(at(`/tasks?taskId=${second.id}&assignee=all&card=${card.id}`));
    await expect(cardDialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#task-panel')).toBeHidden();
    await expect(page).toHaveURL(at(`/tasks?assignee=all&card=${card.id}`));
    await expect(cardDialog).toBeVisible();
    await expect(cardDialog.locator('.card-checklist-label', { hasText: second.description })).toBeFocused();

    // The Task dialog's Card row returns to the Card it was opened from.
    await cardDialog.locator('.card-checklist-label', { hasText: second.description }).click();
    await page.locator('#task-panel').getByRole('button', { name: /Open card/ }).click();
    await expect(page.locator('#task-panel')).toBeHidden();
    await expect(cardDialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(cardDialog).toBeHidden();
    await expect(page).toHaveURL(at('/tasks?assignee=all'));
    await expect(row.locator('.ops-queue-origin-link')).toBeFocused();
  });

  test('Calendar: an event Card opens over the calendar and Escape returns to it', async ({ page, request }) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const calendarWorkday = (isoDate) => {
      const d = new Date(`${isoDate}T00:00:00Z`);
      const day = d.getUTCDay();
      if (day === 0) d.setUTCDate(d.getUTCDate() - 2);
      else if (day === 6) d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    };
    const { template } = await json(await request.post(at('/__e2e__/template-fixtures'), {
      data: {
        name: `Synthetic modal webinar ${unique}`,
        type: 'webinar',
        sourcePath: 'workflow-templates/synthetic-modal-webinar.yaml',
        taskDefinitions: [],
      },
    }), 201);
    const { card } = await json(await request.post(at('/api/cards'), {
      data: { title: `Synthetic calendar webinar ${unique}`, anchorDate: calendarWorkday(today), stage: 'announced', templateId: template.id },
    }), 201);
    await page.goto(at('/calendar'));
    const event = page.locator('.calendar-surface a[href="/cards?cardId=' + card.id + '"]').first();
    await expect(event).toBeVisible({ timeout: 20000 });
    await event.click();
    await expect(page.getByRole('dialog', { name: card.title })).toBeVisible();
    await expect(page).toHaveURL(at(`/calendar?card=${card.id}`));
    await expect(page.locator('.calendar-surface')).toBeAttached();

    await page.keyboard.press('Escape');
    await expect(page.locator('#card-panel')).toBeHidden();
    await expect(page).toHaveURL(at('/calendar'));
    await expect(page.locator('.calendar-surface')).toBeVisible();
  });

  test('phone: the Card dialog fills the screen', async ({ page, request }) => {
    const { card } = await seedQueueCard(request, 'phone');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(at(`/tasks?assignee=all&card=${card.id}`));
    const panel = page.locator('#card-panel .workflow-modal-panel');
    await expect(panel).toBeVisible({ timeout: 20000 });
    const box = await panel.boundingBox();
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.y)).toBe(0);
    expect(Math.round(box.width)).toBe(390);
    expect(Math.round(box.height)).toBe(844);
  });
});
