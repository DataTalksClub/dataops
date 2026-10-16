// The task dialog's "Needs" editor: the kit tag input (dakit dk-tag-input)
// over the GET /api/resources vocabulary, edited as a draft and saved once.
const { test, expect } = require('@playwright/test');
const { emptyTemplateId } = require('./helpers/card-template');

async function json(response, status = 200) {
  expect(response.status()).toBe(status);
  return response.json();
}

async function taskNeeding(request, requires) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { card } = await json(await request.post('/api/cards', {
    data: { title: `Synthetic needs card ${unique}`, anchorDate: '2026-08-20', stage: 'announced', templateId: await emptyTemplateId(request) },
  }), 201);
  const created = await json(await request.post('/api/tasks', {
    data: { description: `Synthetic needs step ${unique}`, date: '2026-08-20', cardId: card.id },
  }), 201);
  const task = await json(await request.put(`/api/tasks/${created.id}`, {
    data: { requires, expectedVersion: created.version },
  }));
  return { card, task, unique };
}

async function openNeeds(page, { card, task, unique }) {
  await page.goto(`/cards?cardId=${card.id}&taskId=${task.id}`);
  await expect(page.locator('#task-panel-title')).toContainText(`Synthetic needs step ${unique}`);
  return page.locator('#task-panel section.task-requires');
}

const chips = (needs) => needs.locator('.dk-tag-input__chip .dk-tag-input__text');

test.describe('task Needs tag input', () => {
  test('keyboard: type to filter, Enter adds, Backspace removes, Save writes once', async ({ page, request }) => {
    const fixture = await taskNeeding(request, ['finom']);
    const needs = await openNeeds(page, fixture);
    await needs.getByRole('button', { name: 'Edit what this task needs' }).click();

    const combo = needs.getByRole('combobox', { name: 'Needs' });
    await expect(combo).toBeFocused();
    await expect(chips(needs)).toHaveText(['Finom']);

    await page.keyboard.type('yout');
    await expect(combo).toHaveAttribute('aria-expanded', 'true');
    const listbox = needs.getByRole('listbox');
    await expect(listbox.getByRole('option')).toHaveText(['YouTube']);
    await page.keyboard.press('Enter');
    await expect(chips(needs)).toHaveText(['Finom', 'YouTube']);
    await expect(combo).toHaveValue('');

    await page.keyboard.type('zzzq');
    await expect(needs.locator('.dk-tag-input__empty')).toHaveText('No matching resource');
    await page.keyboard.press('Escape');
    await expect(combo).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');
    await expect(combo).toHaveValue('');

    await page.keyboard.press('Backspace');
    await expect(chips(needs)).toHaveText(['Finom']);

    // ↓ moves from the best match to the next one; Enter takes it.
    await page.keyboard.type('GOOG');
    const googles = await listbox.getByRole('option').allTextContents();
    expect(googles.length).toBeGreaterThan(1);
    expect(googles.every((name) => name.startsWith('Google'))).toBe(true);
    await page.keyboard.press('ArrowDown');
    const active = await combo.getAttribute('aria-activedescendant');
    await expect(page.locator(`[id="${active}"]`)).toHaveText(googles[1]);
    await page.keyboard.press('Enter');
    await expect(chips(needs)).toHaveText(['Finom', googles[1]]);
    const second = await json(await request.get('/api/resources'));
    const secondId = second.resources.find((resource) => resource.name === googles[1]).id;

    const writes = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes(`/api/tasks/${fixture.task.id}`)) writes.push(r.postDataJSON()); });
    await needs.getByRole('button', { name: 'Save' }).click();
    await expect(needs.locator('.ops-resource-name')).toHaveText(['Finom', googles[1]]);
    await expect(needs.getByRole('combobox')).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ requires: ['finom', secondId], expectedVersion: fixture.task.version });
    const saved = await json(await request.get(`/api/tasks/${fixture.task.id}`));
    expect(saved.requires).toEqual(['finom', secondId]);
  });

  test('a panel rebuild mid-typing keeps the open, filtered list', async ({ page, request }) => {
    const fixture = await taskNeeding(request, ['finom']);
    // Hold the Task's artifact hydration so it lands, and rebuilds the
    // panel, only after the operator has typed into the open editor.
    let releaseArtifacts;
    const artifactsHeld = new Promise((resolve) => { releaseArtifacts = resolve; });
    await page.route(`**/api/artifacts?taskId=${fixture.task.id}*`, async (route) => {
      await artifactsHeld;
      await route.continue();
    });
    const needs = await openNeeds(page, fixture);
    await needs.getByRole('button', { name: 'Edit what this task needs' }).click();
    const combo = needs.getByRole('combobox', { name: 'Needs' });
    await expect(combo).toBeFocused();
    await page.keyboard.type('yout');
    await expect(combo).toHaveAttribute('aria-expanded', 'true');

    // Mark this panel's section; the hydration rebuild replaces it.
    await needs.evaluate((section) => { section.dataset.beforeRebuild = 'true'; });
    releaseArtifacts();
    await expect(page.locator('#task-panel section.task-requires:not([data-before-rebuild])')).toHaveCount(1);
    await expect(combo).toBeFocused();
    await expect(combo).toHaveValue('yout');
    await expect(combo).toHaveAttribute('aria-expanded', 'true');
    await expect(needs.getByRole('listbox').getByRole('option')).toHaveText(['YouTube']);
    await page.keyboard.press('Enter');
    await expect(chips(needs)).toHaveText(['Finom', 'YouTube']);
  });

  test('mouse: the chips open the editor, an option click adds, × removes; Esc discards the draft', async ({ page, request }) => {
    const fixture = await taskNeeding(request, ['finom', 'youtube']);
    const needs = await openNeeds(page, fixture);
    await needs.locator('.ops-resources--named').click();

    const combo = needs.getByRole('combobox', { name: 'Needs' });
    await expect(combo).toBeFocused();
    await combo.click();
    const listbox = needs.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'Finom' })).toHaveCount(0);
    await listbox.getByRole('option', { name: 'Luma' }).click();
    await expect(chips(needs)).toHaveText(['Finom', 'YouTube', 'Luma']);
    await expect(combo).toBeFocused();
    await needs.getByRole('button', { name: 'Remove Finom' }).click();
    await expect(chips(needs)).toHaveText(['YouTube', 'Luma']);

    // Esc closes the list, then leaves the editor without saving; the dialog stays.
    await combo.press('Escape');
    await combo.press('Escape');
    await expect(needs.getByRole('combobox')).toHaveCount(0);
    await expect(page.locator('#task-panel')).toBeVisible();
    await expect(needs.locator('.ops-resource-name')).toHaveText(['Finom', 'YouTube']);
    await expect(needs.getByRole('button', { name: 'Edit what this task needs' })).toBeFocused();

    await needs.getByRole('button', { name: 'Edit what this task needs' }).click();
    await needs.getByRole('button', { name: 'Remove YouTube' }).click();
    await needs.getByRole('button', { name: 'Remove Finom' }).click();
    await needs.getByRole('button', { name: 'Save' }).click();
    await expect(needs).toContainText('Nothing outside DataOps.');
    await expect(needs.getByRole('button', { name: 'Add what this task needs' })).toBeVisible();
    expect((await json(await request.get(`/api/tasks/${fixture.task.id}`))).requires ?? []).toEqual([]);
  });

  test('375px: the editor fits the phone dialog and a tap adds', async ({ page, request }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const fixture = await taskNeeding(request, ['finom']);
    const needs = await openNeeds(page, fixture);
    await needs.getByRole('button', { name: 'Edit what this task needs' }).click();
    const combo = needs.getByRole('combobox', { name: 'Needs' });
    await combo.click();
    await needs.getByRole('option', { name: 'Zoom' }).click();
    await expect(chips(needs)).toHaveText(['Finom', 'Zoom']);
    const box = await needs.locator('.dk-tag-input').evaluate((el) => {
      const field = el.getBoundingClientRect();
      const popup = el.querySelector('.dk-tag-input__popup').getBoundingClientRect();
      return { left: Math.min(field.left, popup.left), right: Math.max(field.right, popup.right), height: el.querySelector('.dk-tag-input__field').offsetHeight };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(375);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});
