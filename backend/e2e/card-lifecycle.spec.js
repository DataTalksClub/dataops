const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', '.tmp', 'issue-168');

test.describe('canonical Card lifecycle', () => {
  test('retains a final-Task conflict, completes into Archive, and reopens into the active stage', async ({ page, request }) => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const createdCard = await request.post('/api/cards', {
      data: {
        title: `Synthetic lifecycle ${unique}`,
        anchorDate: '2026-08-13',
        stage: 'after-event',
      },
    });
    expect(createdCard.status()).toBe(201);
    const cardId = (await createdCard.json()).card.id;
    const createdTask = await request.post('/api/tasks', {
      data: {
        description: `Synthetic final task ${unique}`,
        date: '2026-08-13',
        cardId,
      },
    });
    expect(createdTask.status()).toBe(201);
    const taskId = (await createdTask.json()).id;
    const currentTask = await (await request.get(`/api/tasks/${taskId}`)).json();
    const currentCard = (await (await request.get(`/api/cards/${cardId}`)).json()).card;

    await page.goto(`/#/cards?cardId=${cardId}&taskId=${taskId}`);
    await expect(page.locator('#card-panel')).toBeVisible();
    await expect(page.locator('#task-panel')).toBeVisible();
    await expect(page.locator('#task-panel-title')).toContainText(`Synthetic final task ${unique}`);

    let conflicts = 0;
    await page.route(`**/work/api/tasks/${taskId}`, async (route) => {
      if (route.request().method() !== 'PUT' || conflicts > 0) {
        await route.continue();
        return;
      }
      conflicts += 1;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Card or its Tasks changed; review current work and retry',
          code: 'card_lifecycle_conflict',
          currentTask,
          currentCard,
        }),
      });
    });

    await page.locator('#task-panel').getByRole('button', { name: 'Mark done' }).click();
    const conflict = page.locator('#task-panel [role="alert"]');
    await expect(conflict).toBeFocused();
    await expect(conflict).toContainText('This Card or its Tasks changed elsewhere');
    await expect(conflict).toContainText('Your retained change: Set status to done');
    await expect(conflict).toContainText(`Card version ${currentCard.version}, After Event`);
    await conflict.getByRole('button', { name: 'Review latest' }).click();
    await expect(conflict).toContainText('Your retained change: Set status to done');
    await conflict.getByRole('button', { name: 'Retry my change' }).click();

    await expect(page).toHaveURL(new RegExp(`/#/cards/archive\\?cardId=${cardId}&taskId=${taskId}$`));
    await expect(page.locator('#card-panel')).toBeVisible();
    await expect(page.locator('#card-panel')).toContainText('Completed');
    await expect(page.locator('#card-panel')).toContainText('from After Event');
    await expect(page.locator('#task-panel').getByRole('button', { name: 'Reopen' })).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'card-completed-archive.png'),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#task-panel').getByRole('button', { name: 'Reopen' }).click();
    await expect(page).toHaveURL(new RegExp(`/#/cards\\?cardId=${cardId}&taskId=${taskId}$`));
    await expect(page.locator('#card-panel')).toContainText('After Event');
    await expect(page.getByText('Task reopened. Card restored to after event.')).toBeVisible();
    await expect(page.locator('#task-panel').getByRole('button', { name: 'Mark done' })).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'card-reactivated-narrow.png'),
      fullPage: true,
    });
  });
});
