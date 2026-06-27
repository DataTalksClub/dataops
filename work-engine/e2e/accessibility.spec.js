const { test, expect } = require('@playwright/test');

const GRACE_ID = '00000000-0000-0000-0000-000000000001';

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

async function createTemplate(request, data) {
  const res = await request.post('/api/templates', { data });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return body.template;
}

async function createBundle(request, data) {
  const res = await request.post('/api/bundles', { data });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return body.bundle;
}

async function archiveAndDeleteBundle(request, bundleId) {
  if (!bundleId) return;
  await request.put('/api/bundles/' + bundleId + '/archive');
  await request.delete('/api/bundles/' + bundleId);
}

test.describe('Keyboard accessibility', () => {
  test('task bundle badges are keyboard-focusable links to bundle detail', async ({ page, request }) => {
    const title = 'Keyboard Task Badge Bundle ' + uid();
    const bundle = await createBundle(request, {
      title,
      anchorDate: '2026-07-12',
    });
    const taskRes = await request.post('/api/tasks', {
      data: {
        description: 'Keyboard badge task ' + uid(),
        date: '2026-07-12',
        bundleId: bundle.id,
      },
    });
    expect(taskRes.status()).toBe(201);
    const task = await taskRes.json();

    try {
      await page.goto('/#/tasks');
      await page.fill('#task-date', '2026-07-12');
      await page.locator('#task-date').press('Enter');
      await page.waitForSelector('[data-task-row="' + task.id + '"]');

      const badge = page.getByRole('link', { name: 'Open bundle ' + title });
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute('href', '#/bundles');
      await badge.focus();
      await expect(badge).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(page).toHaveURL(/\/#\/bundles/);
      await expect(page.locator('#bundle-detail')).toContainText(title);
    } finally {
      await request.delete('/api/tasks/' + task.id);
      await archiveAndDeleteBundle(request, bundle.id);
    }
  });

  test('dashboard task bundle badges are keyboard-focusable links to bundle detail', async ({ page, request }) => {
    const title = 'Keyboard Dashboard Badge Bundle ' + uid();
    const bundle = await createBundle(request, {
      title,
      anchorDate: '2026-07-13',
    });
    const taskRes = await request.post('/api/tasks', {
      data: {
        description: 'Keyboard dashboard badge task ' + uid(),
        date: todayString(),
        bundleId: bundle.id,
        assigneeId: GRACE_ID,
      },
    });
    expect(taskRes.status()).toBe(201);
    const task = await taskRes.json();

    try {
      await page.goto('/#/');
      await page.waitForSelector('[data-task-row="' + task.id + '"]');

      const badge = page.getByRole('link', { name: 'Open bundle ' + title });
      await expect(badge).toBeVisible();
      await badge.focus();
      await expect(badge).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(page).toHaveURL(/\/#\/bundles/);
      await expect(page.locator('#bundle-detail')).toContainText(title);
    } finally {
      await request.delete('/api/tasks/' + task.id);
      await archiveAndDeleteBundle(request, bundle.id);
    }
  });

  test('template cards expose button semantics and open with Space', async ({ page, request }) => {
    const name = 'Keyboard Template ' + uid();
    const template = await createTemplate(request, {
      name,
      type: 'newsletter',
      emoji: 'K',
      tags: ['keyboard'],
      triggerType: 'manual',
      taskDefinitions: [
        { refId: 'draft', description: 'Draft', offsetDays: -1 },
      ],
    });

    try {
      await page.goto('/#/templates');

      const card = page.getByRole('button', { name: 'Open template ' + name });
      await expect(card).toBeVisible();
      await card.focus();
      await expect(card).toBeFocused();
      await page.keyboard.press('Space');

      await expect(page.locator('#template-editor-container')).toContainText(name);
      await expect(page.locator('.template-editor-header')).toContainText('1 task');
    } finally {
      await request.delete('/api/templates/' + template.id);
    }
  });

  test('dashboard bundle cards expose button semantics and open with Enter', async ({ page, request }) => {
    const title = 'Keyboard Dashboard Bundle ' + uid();
    const bundle = await createBundle(request, {
      title,
      anchorDate: '2026-07-10',
      stage: 'preparation',
    });

    try {
      await page.goto('/#/');

      const card = page.getByRole('button', { name: 'Open bundle ' + title });
      await expect(card).toBeVisible({ timeout: 10000 });
      await card.focus();
      await expect(card).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(page).toHaveURL(/\/#\/bundles/);
      await expect(page.locator('#bundle-detail')).toContainText(title);
    } finally {
      await archiveAndDeleteBundle(request, bundle.id);
    }
  });

  test('bundle list titles are real keyboard-focusable links', async ({ page, request }) => {
    const title = 'Keyboard List Bundle ' + uid();
    const bundle = await createBundle(request, {
      title,
      anchorDate: '2026-07-11',
      description: 'Used to verify title link keyboard activation.',
    });

    try {
      await page.goto('/#/bundles');

      const titleLink = page.getByRole('link', { name: 'Open bundle ' + title });
      await expect(titleLink).toBeVisible({ timeout: 10000 });
      await titleLink.focus();
      await expect(titleLink).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(page.locator('#bundle-detail')).toContainText(title);
    } finally {
      await archiveAndDeleteBundle(request, bundle.id);
    }
  });

  test('notification bell is a keyboard-operable button with expanded state', async ({ page, request }) => {
    await request.put('/api/notifications/dismiss-all');
    await page.goto('/#/');

    const bell = page.getByRole('button', { name: 'Notifications' });
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute('aria-expanded', 'false');

    await bell.focus();
    await expect(bell).toBeFocused();
    await page.keyboard.press('Enter');

    const dropdown = page.locator('#notif-dropdown');
    await expect(bell).toHaveAttribute('aria-expanded', 'true');
    await expect(dropdown).toBeVisible();
    await expect(dropdown).toContainText('No new notifications');

    await page.keyboard.press('Escape');
    await expect(bell).toHaveAttribute('aria-expanded', 'false');
    await expect(dropdown).toBeHidden();
    await expect(bell).toBeFocused();
  });
});
