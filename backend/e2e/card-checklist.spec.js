// The Card checklist keeps even rows: a skipped Task gets its own mark and a
// one-line muted reason that never widens the Card detail.
const { test, expect } = require('@playwright/test');
const { emptyTemplateId } = require('./helpers/card-template');

async function json(response, status = 200) {
  expect(response.status()).toBe(status);
  return response.json();
}

const LONG_REASON = 'No longer applicable on 2026-10-15: Building an AI Platform: the guest already sent the calendar invite and we agreed to skip the pre-interview';

async function createChecklistCard(request) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { card } = await json(await request.post('/api/cards', {
    data: { title: `Synthetic checklist card ${unique}`, anchorDate: '2026-10-20', stage: 'announced', templateId: await emptyTemplateId(request) },
  }), 201);
  const tasks = [];
  for (const description of ['Synthetic open step', 'Synthetic done step', 'Synthetic skipped step with a calendar invite']) {
    tasks.push(await json(await request.post('/api/tasks', {
      data: { description, date: '2026-10-18', cardId: card.id },
    }), 201));
  }
  await json(await request.put(`/api/tasks/${tasks[1].id}`, { data: { status: 'done', expectedVersion: tasks[1].version } }));
  await json(await request.post(`/api/tasks/${tasks[2].id}/actions/skip`, {
    data: { reason: LONG_REASON, expectedVersion: tasks[2].version },
  }));
  return { card, tasks };
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  test(`Card checklist rows stay even and inside the panel at ${viewport.width}px`, async ({ page, request }) => {
    const { card, tasks } = await createChecklistCard(request);
    await page.setViewportSize(viewport);
    await page.goto(`/cards?cardId=${card.id}`);
    const panel = page.locator('#card-panel');
    const rows = panel.locator('.card-checklist-item');
    await expect(rows).toHaveCount(3);

    const skipped = rows.filter({ has: page.locator(`[data-task-id="${tasks[2].id}"]`) });
    await expect(skipped.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(skipped.getByRole('img', { name: 'Skipped' })).toBeVisible();
    await expect(skipped.locator('.card-checklist-label')).not.toHaveClass(/is-done/);
    const note = skipped.locator('.card-checklist-note');
    await expect(note).toHaveAttribute('title', `Skipped: ${LONG_REASON}`);

    const body = await panel.locator('#card-panel-body').boundingBox();
    for (const box of [await note.boundingBox(), await skipped.boundingBox()]) {
      expect(box.x + box.width).toBeLessThanOrEqual(body.x + body.width + 0.5);
    }
    expect(await note.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

    // A one-line open row is compact; the owner column exists on every row.
    const open = rows.filter({ has: page.locator(`[data-task-id="${tasks[0].id}"]`) });
    const openBox = await open.boundingBox();
    expect(openBox.height).toBeLessThanOrEqual(viewport.width < 640 ? 52 : 40);
    await expect(panel.locator('.card-checklist-owner')).toHaveCount(3);
    await expect(panel.locator('.card-checklist-percent')).toHaveText('67%');
  });
}
