const { test, expect } = require('@playwright/test');
const { emptyTemplateId } = require('./helpers/card-template');

// Background refreshes (the bootstrap work snapshot, the Users list a route
// loads) land whenever the network lets them. They must not replace the
// control an operator is using: the repaint waits until the operator is done,
// then shows the new data.

async function json(response, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

function runTag() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createPerson(request, baseName) {
  const tag = runTag();
  const { user } = await json(await request.post('/api/users', {
    data: { name: `${baseName} ${tag}`, email: `synthetic-${tag}@example.invalid`, role: 'operator' },
  }), 201);
  return user;
}

async function createCard(request, title) {
  const { card } = await json(await request.post('/api/cards', {
    data: { title, anchorDate: '2026-08-20', stage: 'announced', templateId: await emptyTemplateId(request) },
  }), 201);
  return card;
}

// Tag the element so the test can tell "the same element" from "a fresh
// element that looks the same".
async function mark(locator) {
  await locator.evaluate((node) => { node.dataset.e2eOriginal = 'yes'; });
}

test.describe('background refresh while the operator is mid-interaction', () => {
  test('the Users default-assignee select keeps focus and the new person appears after blur', async ({ page, request }) => {
    await createPerson(request, 'Synthetic Present');
    await page.goto('/users');
    await expect(page.locator('.ops-users-table')).toBeVisible();
    // Start from a settled page so the only refresh in play is the one below.
    await page.waitForLoadState('networkidle');

    const select = page.getByLabel('Default assignee');
    await mark(select);
    await select.focus();
    await expect(select).toBeFocused();

    const late = await createPerson(request, 'Synthetic Late Arrival');
    await page.evaluate(() => Promise.all([window.__dataopsRefreshWork(), window.__dataopsRefreshUsers()]));

    // The data changed, but the operator is in the select: nothing moved.
    await expect(select).toBeFocused();
    await expect(page.locator('#ops-default-assignee-select[data-e2e-original="yes"]')).toHaveCount(1);
    await expect(select.locator(`option[value="${late.id}"]`)).toHaveCount(0);

    // Leaving the select lets the waiting repaint through.
    await page.getByRole('heading', { name: 'Users' }).first().click();
    await expect(select.locator(`option[value="${late.id}"]`)).toHaveCount(1);
    await expect(page.locator('.ops-user-row', { hasText: late.name })).toHaveCount(1);
    await expect(page.locator('#ops-default-assignee-select[data-e2e-original="yes"]')).toHaveCount(0);
  });

  test('a task skip dialog keeps its typed reason and the Cards board updates after it closes', async ({ page, request }) => {
    const tag = runTag();
    const card = await createCard(request, `Synthetic refresh card ${tag}`);
    const task = await json(await request.post('/api/tasks', {
      data: { description: `Synthetic refresh step ${tag}`, date: '2026-08-20', cardId: card.id },
    }), 201);

    await page.goto(`/cards?cardId=${card.id}&taskId=${task.id}`);
    const panel = page.locator('#task-panel');
    await expect(page.locator('#task-panel-title')).toContainText(`Synthetic refresh step ${tag}`);
    await page.waitForLoadState('networkidle');
    const board = page.locator('#document-list');
    await expect(board.locator(`.workflow-board-card[data-card-id="${card.id}"]`)).toHaveCount(1);
    await mark(board.locator(`.workflow-board-card[data-card-id="${card.id}"]`));

    await panel.getByRole('button', { name: 'Skip…' }).click();
    const dialog = page.locator('dialog[data-work-dialog="skip-task"]');
    const reason = dialog.getByLabel('Why are you skipping this?');
    await reason.fill('Self-hosted event, no rec');
    await expect(reason).toBeFocused();

    const late = await createCard(request, `Synthetic late card ${tag}`);
    await page.evaluate(() => window.__dataopsRefreshWork());

    // Typing continues where it was; the board under the dialog is untouched.
    await reason.pressSequentially('ording');
    await expect(reason).toHaveValue('Self-hosted event, no recording');
    await expect(reason).toBeFocused();
    await expect(board.locator(`.workflow-board-card[data-card-id="${late.id}"]`)).toHaveCount(0);
    await expect(board.locator('.workflow-board-card[data-e2e-original="yes"]')).toHaveCount(1);

    // Closing the dialog lets the waiting repaint through.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(board.locator(`.workflow-board-card[data-card-id="${late.id}"]`)).toHaveCount(1);
    await expect(board.locator('.workflow-board-card[data-e2e-original="yes"]')).toHaveCount(0);
    expect((await json(await request.get(`/api/tasks/${task.id}`))).status).toBe('todo');
  });
});
