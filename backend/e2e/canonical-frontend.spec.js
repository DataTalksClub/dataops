const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const SHOTS = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots');

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe('canonical DataOps frontend', () => {
  test('resolves legacy hash routes inside one navigation shell', async ({ page, request }) => {
    await page.goto('/#/');
    await expect(page.locator('#document-list')).toBeVisible();
    await expect(page.locator('button[data-workspace-view="home"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('button[data-workspace-view="inbox"]')).toBeVisible();

    await page.goto('/#/cards');
    await expect(page.getByRole('heading', { name: 'Cards', exact: true })).toBeVisible();
    await expect(page.locator('[data-tasks-section="workflows"]')).toHaveAttribute('aria-current', 'page');

    await page.goto('/#/recurring');
    await expect(page.getByRole('heading', { name: 'Recurring', exact: true })).toBeVisible();
    await expect(page.locator('[data-tasks-section="recurring"]')).toHaveAttribute('aria-current', 'page');

    await page.goto('/#/notifications');
    await expect(page.locator('#work-bell-panel')).toBeVisible();

    expect((await request.get('/public/app.js')).status()).toBe(404);
    expect((await request.get('/public/api.js')).status()).toBe(404);
  });

  test('opens task and workflow entity deep links in canonical panels', async ({ page, request }) => {
    const id = suffix();
    const cardResponse = await request.post('/api/cards', {
      data: { title: `Canonical workflow ${id}`, anchorDate: '2026-08-11' },
    });
    expect(cardResponse.status()).toBe(201);
    const card = (await cardResponse.json()).card;
    const taskResponse = await request.post('/api/tasks', {
      data: { description: `Canonical task ${id}`, date: '2026-08-11', cardId: card.id },
    });
    expect(taskResponse.status()).toBe(201);
    const task = await taskResponse.json();

    await page.goto(`/#/cards?cardId=${card.id}`);
    await expect(page.locator('#card-panel')).toBeVisible();
    await expect(page.locator('#card-panel-title')).toContainText(`Canonical workflow ${id}`);

    await page.goto(`/#/tasks?taskId=${task.id}`);
    await expect(page.locator('#task-panel')).toBeVisible();
    await expect(page.locator('#task-panel-title')).toContainText(`Canonical task ${id}`);
  });

  test('captures and triages Inbox items in the canonical surface', async ({ page, request }) => {
    const id = suffix();
    const response = await request.post('/api/intake', {
      data: { source: 'manual', title: `Canonical intake ${id}`, note: 'Safe synthetic intake context', dataClass: 'internal' },
    });
    expect(response.status()).toBe(201);
    const item = (await response.json()).item;

    await page.goto(`/#/inbox?intakeId=${item.id}`);
    await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
    const row = page.locator('.intake-row', { hasText: `Canonical intake ${id}` });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Convert to task' })).toBeVisible();
    await expect(page.locator('.intake-action-disclosure')).toHaveCount(0);
    await expect(page.locator('[data-intake-submit="follow-up-sent"]')).toHaveCount(0);
    const block = row.locator('[data-intake-action="block"]');
    await block.locator('[name="waitingFor"]').fill('Synthetic external response');
    await block.locator('[name="followUpAt"]').fill('2026-08-14');
    await block.locator('[name="reason"]').fill('Waiting for a safe synthetic response');
    await block.locator('[data-intake-submit="block"]').click();
    await expect(row).toContainText('blocked');
  });

  test('shows Inbox as a list without invoice-route work', async ({ page, request }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const id = suffix();
    const noteTitle = `Ad-hoc inbox note ${id}`;
    const invoiceTitle = `Synthetic forwarded receipt ${id}`;
    await request.post('/api/intake', {
      data: { source: 'manual', title: noteTitle, note: 'Public-safe operator note', dataClass: 'internal' },
    });
    await request.post('/api/intake', {
      data: {
        source: 'email',
        title: invoiceTitle,
        note: 'Public-safe invoice-route fixture',
        dataClass: 'internal',
        metadata: { recipientRoute: 'invoice' },
      },
    });

    const fulfillIntake = async (route, items) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.pathname.replace(/\/$/, '') !== '/work/api/intake') {
        return route.continue();
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items }),
      });
    };
    const openInbox = async (items, size) => {
      await page.unroute('**/work/api/intake*');
      await page.setViewportSize(size);
      await page.route('**/work/api/intake*', (route) => fulfillIntake(route, items));
      await page.goto('/#/inbox');
      if (size.width <= 390) {
        await page.evaluate(() => document.body.classList.remove('sidebar-open'));
      }
    };
    const shot = async (name, fullPage) => {
      await page.screenshot({ path: path.join(SHOTS, name), fullPage });
    };

    const desktop = { width: 1440, height: 900 };
    const mobile = { width: 390, height: 844 };
    await openInbox([], desktop);
    await expect(page.getByText('Nothing to triage')).toBeVisible();
    await expect(page.getByText('Forwarded invoices are reviewed in Finance, not Inbox.')).toBeVisible();
    await shot('inbox-empty-desktop-1440x900.png', true);

    await openInbox([], mobile);
    await expect(page.getByText('Nothing to triage')).toBeVisible();
    await shot('inbox-empty-mobile-390x844.png', false);

    const oneItem = [{
      id: 'note-1',
      title: noteTitle,
      status: 'new',
      source: 'manual',
      sourceReceivedAt: '2026-08-12T10:00:00.000Z',
      summary: 'Public-safe operator note',
    }];
    await openInbox(oneItem, desktop);
    await expect(page.locator('.intake-row', { hasText: noteTitle })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Convert to task' })).toBeVisible();
    await shot('inbox-one-item-desktop-1440x900.png', true);

    await openInbox(oneItem, mobile);
    await expect(page.locator('.intake-row', { hasText: noteTitle })).toBeVisible();
    await shot('inbox-one-item-mobile-390x844.png', false);

    const mixed = [
      ...oneItem,
      {
        id: 'invoice-1',
        title: invoiceTitle,
        status: 'new',
        source: 'email',
        sourceReceivedAt: '2026-08-12T10:00:00.000Z',
        summary: 'Public-safe invoice-route fixture',
        metadata: { recipientRoute: 'invoice' },
      },
    ];
    await openInbox(mixed, desktop);
    await expect(page.locator('.intake-row', { hasText: noteTitle })).toBeVisible();
    await expect(page.locator('.intake-row', { hasText: invoiceTitle })).toHaveCount(0);
    await shot('inbox-invoice-absent-desktop-1440x900.png', true);

    await openInbox(mixed, mobile);
    await expect(page.locator('.intake-row', { hasText: noteTitle })).toBeVisible();
    await expect(page.locator('.intake-row', { hasText: invoiceTitle })).toHaveCount(0);
    await shot('inbox-invoice-absent-mobile-390x844.png', false);

    await page.unroute('**/work/api/intake*');
    await page.setViewportSize(desktop);
    await page.goto('/#/inbox');
    await expect(page.locator('.intake-row', { hasText: noteTitle })).toBeVisible();
    await expect(page.locator('.intake-row', { hasText: invoiceTitle })).toHaveCount(0);
  });

  test('runs and reviews an assistant job from the canonical lifecycle UI', async ({ page, request }) => {
    const id = suffix();
    const cardResponse = await request.post('/api/cards', {
      data: { title: `Assistant workflow ${id}`, anchorDate: '2026-08-11' },
    });
    const card = (await cardResponse.json()).card;
    const jobResponse = await request.post('/api/assistant-jobs', {
      data: {
        assistantType: 'podcast',
        title: `Canonical assistant ${id}`,
        cardId: card.id,
        inputRefs: [{ type: 'card', id: card.id }],
        approvalRequired: true,
        maxAttempts: 2,
      },
    });
    expect(jobResponse.status()).toBe(201);
    const job = (await jobResponse.json()).job;

    await page.goto(`/#/assistants?assistantJobId=${job.id}`);
    await expect(page.getByRole('heading', { name: 'Assistants', exact: true })).toBeVisible();
    await expect(page.locator('.assistant-detail h3')).toHaveText(`Canonical assistant ${id}`);
    await expect(page.locator('[data-assistant-save]')).toBeVisible();
    await expect(page.locator('[data-assistant-lifecycle="submit"]')).toBeVisible();
    await page.locator('[data-assistant-lifecycle="run-dry"]').click();
    await expect(page.locator('.assistant-artifacts a')).toHaveCount(1);
    await expect(page.locator('[data-assistant-lifecycle="approve"]')).toBeVisible();
  });

  test('inspects the database-backed Git projection without mutation controls', async ({ page }) => {
    await page.goto('/#/templates');
    const row = page.locator('.runtime-template-row', { hasText: 'Synthetic Git-authored workflow' });
    await expect(row).toBeVisible();
    await row.click();
    const projection = page.locator('.runtime-template-projection');
    await expect(projection).toContainText('workflow-templates/synthetic-git-workflow.yaml');
    await expect(projection).toContainText('0123456789ab');
    await expect(projection.getByRole('button', { name: 'Create card' })).toBeVisible();
    await expect(page.getByRole('button', { name: /template/i }).filter({ hasText: /new|save|delete/i })).toHaveCount(0);
  });
});
