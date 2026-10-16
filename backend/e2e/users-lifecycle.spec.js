const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Before/after evidence for the Users page lands here when a run asks for it.
const SHOTS = process.env.USERS_SCREENSHOT_DIR || '';

async function json(response, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

// Every person gets a run-unique name: the table is shared across specs and
// retries, so a fixed name would match a leftover row from an earlier attempt.
async function createPerson(request, baseName) {
  const tag = Math.random().toString(36).slice(2, 7);
  const unique = `${Date.now()}-${tag}`;
  const { user } = await json(await request.post('/api/users', {
    data: { name: `${baseName} ${tag}`, email: `synthetic-${unique}@example.invalid`, role: 'operator' },
  }), 201);
  return user;
}

async function openUsers(page) {
  await page.goto('/users');
  await expect(page.locator('.ops-users-table')).toBeVisible();
}

function row(page, name) {
  return page.locator('.ops-user-row', { has: page.locator('.ops-user-name strong', { hasText: new RegExp(`^${name}$`) }) });
}

async function menuItem(page, name, item) {
  await row(page, name).getByRole('button', { name: `Actions for ${name}` }).click();
  return page.getByRole('menuitem', { name: item });
}

test.describe('Users: compact layout, and a person leaving', () => {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: '375', width: 375, height: 667 }]) {
    test(`one row control and a compact default assignee at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openUsers(page);
      const select = page.getByLabel('Default assignee');
      await expect(select).toBeVisible();
      // Every row carries exactly one, same-size control.
      const sizes = await page.locator('.ops-user-row').evaluateAll((rows) => rows.map((tableRow) => {
        const triggers = tableRow.querySelectorAll('.ops-user-actions > * > button:not([role="menuitem"])');
        const box = triggers[0]?.getBoundingClientRect();
        return `${triggers.length}:${Math.round(box?.width || 0)}x${Math.round(box?.height || 0)}`;
      }));
      expect(sizes.length).toBeGreaterThan(1);
      expect(new Set(sizes).size).toBe(1);
      expect(sizes[0]).toBe(viewport.width <= 820 ? '1:44x44' : '1:32x32');

      const selectBox = await select.boundingBox();
      expect(selectBox.width).toBeLessThanOrEqual(Math.min(288, viewport.width - 32));
      await expect(page.locator('.ops-default-assignee').getByRole('button', { name: 'Save' })).toHaveCount(0);
      const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
      await shot(page, `users-${viewport.name}`);
    });
  }

  test('the row menu offers Disable to an active account and Delete only once disabled', async ({ page, request }) => {
    const person = await createPerson(request, 'Synthetic Menu Person');
    await openUsers(page);
    await row(page, person.name).getByRole('button', { name: `Actions for ${person.name}` }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Edit', 'Reassign open work…', 'Disable…']);
    await shot(page, 'users-menu-desktop');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await json(await request.post(`/api/users/${person.id}/disable`, { data: {} }));
    await openUsers(page);
    await row(page, person.name).getByRole('button', { name: `Actions for ${person.name}` }).click();
    await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['Edit', 'Reassign open work…', 'Enable', 'Delete…']);
  });

  test('disabling asks who takes the open work, then delete leaves only the name', async ({ page, request }) => {
    const leaver = await createPerson(request, 'Synthetic Leaver');
    const heir = await createPerson(request, 'Synthetic Heir');
    const tasks = [];
    for (const description of ['Synthetic open one', 'Synthetic open two']) {
      tasks.push(await json(await request.post('/api/tasks', {
        data: { description, date: '2026-10-20', assigneeId: leaver.id },
      }), 201));
    }

    await openUsers(page);
    await (await menuItem(page, leaver.name, 'Disable…')).click();
    const dialog = page.locator('dialog[data-user-dialog="disable"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`${leaver.name} has 2 open tasks.`);
    await shot(page, 'users-disable-dialog');
    await dialog.getByRole('button', { name: `Disable ${leaver.name}` }).click();
    await expect(dialog.locator('.user-lifecycle-error')).toContainText('Choose who takes over the open work.');
    await dialog.getByLabel('Hand over to').selectOption(heir.id);
    await dialog.getByRole('button', { name: `Disable ${leaver.name}` }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.ops-users-outcome')).toHaveText(`${leaver.name} is now disabled. 2 open tasks went to ${heir.name}.`);
    await expect(row(page, leaver.name)).toContainText('disabled');
    for (const task of tasks) {
      expect((await json(await request.get(`/api/tasks/${task.id}`))).assigneeId).toBe(heir.id);
    }

    await (await menuItem(page, leaver.name, 'Delete…')).click();
    const confirm = page.locator('dialog[data-user-dialog="delete"]');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByLabel('Hand over to')).toHaveCount(0);
    await shot(page, 'users-delete-dialog');
    await confirm.getByRole('button', { name: `Delete ${leaver.name}` }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('.ops-users-outcome')).toHaveText(`${leaver.name} was deleted; past work still shows the name.`);
    await expect(row(page, leaver.name)).toHaveCount(0);
    const listing = await json(await request.get('/api/users'));
    expect(listing.formerUsers).toEqual(expect.arrayContaining([expect.objectContaining({ id: leaver.id, name: leaver.name })]));
  });

  test('reassign moves a person\'s open work on its own', async ({ page, request }) => {
    const gone = await createPerson(request, 'Synthetic Gone');
    const heir = await createPerson(request, 'Synthetic Taker');
    const task = await json(await request.post('/api/tasks', {
      data: { description: 'Synthetic stranded task', date: '2026-10-21', assigneeId: gone.id },
    }), 201);
    await openUsers(page);
    await (await menuItem(page, gone.name, 'Reassign open work…')).click();
    const dialog = page.locator('dialog[data-user-dialog="reassign"]');
    await expect(dialog).toContainText(`${gone.name} has 1 open task.`);
    await dialog.getByLabel('Hand over to').selectOption(heir.id);
    await dialog.getByRole('button', { name: 'Reassign' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.ops-users-outcome')).toHaveText(`Moved 1 open task from ${gone.name} to ${heir.name}.`);
    expect((await json(await request.get(`/api/tasks/${task.id}`))).assigneeId).toBe(heir.id);
  });

  test('the default assignee saves on change and confirms with a toast', async ({ page, request }) => {
    const person = await createPerson(request, 'Synthetic Default');
    const before = await json(await request.get('/api/team-members/default-assignee'));
    await openUsers(page);
    await page.getByLabel('Default assignee').selectOption(person.id);
    await expect(page.locator('.ops-users-toast')).toHaveText(`New tasks now go to ${person.name}.`);
    expect((await json(await request.get('/api/team-members/default-assignee'))).defaultAssigneeId).toBe(person.id);
    await expect(row(page, person.name)).toContainText('default assignee');
    await expect(page.getByLabel('Default assignee')).toBeFocused();

    // Leave the workspace as it was for the specs that follow.
    const now = await json(await request.get('/api/team-members/default-assignee'));
    await json(await request.put('/api/team-members/default-assignee', {
      data: { defaultAssigneeId: before.defaultAssigneeId, expectedVersion: now.version },
    }));
  });

  // A row at the bottom of the screen opens its menu upward: the menu is
  // placed against the viewport, and below the trigger it would fall off it.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 560 }, { name: '375', width: 375, height: 560 }]) {
    test(`the row menu stays on screen for a row at the bottom at ${viewport.name}`, async ({ page, request }) => {
      for (let index = 0; index < 6; index += 1) await createPerson(request, 'Synthetic Bottom Person');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openUsers(page);
      const last = page.locator('.ops-user-row').last();
      const trigger = last.locator('.ops-user-menu-trigger');
      await trigger.evaluate((node) => node.scrollIntoView({ block: 'end' }));
      // Let the scroll event land before opening: the menu closes on scroll.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const triggerBox = await trigger.boundingBox();
      await trigger.click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const menuBox = await menu.boundingBox();
      // The trigger really sits too low for the menu to open downward.
      expect(triggerBox.y + triggerBox.height + menuBox.height).toBeGreaterThan(viewport.height);
      expect(menuBox.y).toBeGreaterThanOrEqual(0);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y);
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
      await shot(page, `users-menu-bottom-${viewport.name}`);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    });
  }
});
