const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { TEST_SERVER_PORT } = require('./test-server-port');

const SHOT_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '.agent-runs',
  'issue-208-browser',
);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const BASE_URL = `http://127.0.0.1:${TEST_SERVER_PORT}`;

function json(route, status, payload) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });
}

async function captureDesktopAndMobile(page, name) {
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(200);
  await page.screenshot({
    path: path.join(SHOT_ROOT, `${name}-desktop.png`),
    fullPage: true,
  });
  await page.setViewportSize(MOBILE);
  await page.waitForTimeout(200);
  await page.screenshot({
    path: path.join(SHOT_ROOT, `${name}-mobile.png`),
    fullPage: true,
  });
  await page.setViewportSize(DESKTOP);
}

async function keyboardRetry(page, control, cursorResponse) {
  await control.focus();
  await expect(control).toBeFocused();
  await Promise.all([
    cursorResponse,
    page.keyboard.press('Enter'),
  ]);
}

test.describe('issue 208 paginated collections', () => {
  test('Home reports retained Cards across a failed continuation and recovers without duplicates', async ({ page }) => {
    let continuationOnline = false;
    const card = (id, title) => ({
      anchorDate: '2026-08-26',
      id,
      openTaskCount: 0,
      stage: 'preparation',
      status: 'active',
      taskCount: 0,
      title,
      version: 1,
    });
    await page.route('**/work/api/cards*', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (!cursor) {
        return json(route, 200, {
          cards: {
            items: [card('pagination-card-a', 'Card page one')],
            nextCursor: 'opaque-cards-cursor',
          },
        });
      }
      if (!continuationOnline) return json(route, 503, { error: 'Cards continuation offline' });
      return json(route, 200, {
        cards: {
          items: [
            { ...card('pagination-card-a', 'Duplicate page one') },
            card('pagination-card-b', 'Card page two'),
          ],
        },
      });
    });

    await page.goto(`${BASE_URL}/#/`);
    const summary = page.locator('[data-summary-id="home"]');
    await expect(summary).toHaveAttribute('data-summary-state', 'partial');
    await expect(summary.locator('.surface-summary-detail')).toContainText(
      'Cards continuation offline',
    );
    await captureDesktopAndMobile(page, 'cards-continuation-failure');

    continuationOnline = true;
    await keyboardRetry(
      page,
      summary.getByRole('button', { name: /Retry loading work/ }),
      page.waitForResponse((response) =>
        Boolean(new URL(response.url()).searchParams.get('cursor')),
      ),
    );
    await expect(summary).toHaveAttribute('data-summary-state', 'ready');
    await expect(summary.locator('.surface-summary-line')).toContainText(
      '2 active cards',
    );
    await page.goto(`${BASE_URL}/#/cards`);
    await expect(page.locator('.ops-workflows-board')).toBeVisible();
    await expect(page.locator('.workflow-card-title')).toHaveText([
      'Card page one',
      'Card page two',
    ]);
    await captureDesktopAndMobile(page, 'cards-duplicate-free-recovery');
  });

  test('Inbox preserves Card relationships across a failed continuation and retries without duplicates', async ({ page }) => {
    let continuationOnline = false;
    const card = (id, title) => ({
      id,
      status: 'active',
      title,
      version: 1,
    });
    const intake = {
      cardIds: ['inbox-card-a', 'inbox-card-b'],
      dataClass: 'internal',
      id: 'pagination-intake-item',
      source: 'manual',
      status: 'new',
      summary: 'Inbox pagination synthetic item',
      title: 'Inbox pagination item',
    };
    await page.route('**/work/api/intake*', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname !== '/work/api/intake') return route.continue();
      return json(route, 200, { items: [intake] });
    });
    await page.route('**/work/api/cards*', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (!cursor) {
        return json(route, 200, {
          cards: {
            items: [card('inbox-card-a', 'Inbox card page one')],
            nextCursor: 'opaque-inbox-cards-cursor',
          },
        });
      }
      if (!continuationOnline) return json(route, 503, { error: 'Inbox Cards continuation offline' });
      return json(route, 200, {
        cards: {
          items: [
            card('inbox-card-a', 'Duplicate inbox card'),
            card('inbox-card-b', 'Inbox card page two'),
          ],
        },
      });
    });

    await page.goto(`${BASE_URL}/#/inbox?intakeId=${intake.id}`);
    const status = page.locator('.intake-card-status');
    await expect(status).toContainText('More Card relationships are available, but loading failed');
    await expect(status).toContainText('Inbox Cards continuation offline');
    await expect(page.locator('.intake-detail h3')).toHaveText('Inbox pagination item');
    await captureDesktopAndMobile(page, 'inbox-cards-continuation-failure');

    continuationOnline = true;
    await keyboardRetry(
      page,
      status.getByRole('button', { name: 'Retry loading Cards' }),
      page.waitForResponse((response) =>
        Boolean(new URL(response.url()).searchParams.get('cursor')),
      ),
    );
    await expect(page.locator('.intake-card-status')).toHaveCount(0);
    await expect(page.locator('[data-open-intake-card]')).toHaveText([
      'Inbox card page one',
      'Inbox card page two',
    ]);
    await captureDesktopAndMobile(page, 'inbox-cards-duplicate-free-recovery');
  });

  test('task Files follow a cursor and recover a failed continuation', async ({ page, request }) => {
    const cardResponse = await request.post(`${BASE_URL}/api/cards`, {
      data: {
        anchorDate: '2026-08-26',
        stage: 'preparation',
        title: 'Issue 208 pagination Card',
      },
    });
    expect(cardResponse.status()).toBe(201);
    const card = (await cardResponse.json()).card;
    const taskResponse = await request.post(`${BASE_URL}/api/tasks`, {
      data: {
        date: '2026-08-26',
        description: 'Issue 208 paged evidence',
        cardId: card.id,
        requiresFile: true,
      },
    });
    expect(taskResponse.status()).toBe(201);
    const taskId = (await taskResponse.json()).id;
    let continuationOnline = false;
    await page.route('**/work/api/files*', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (!cursor) {
        return json(route, 200, {
          files: {
            items: [{ filename: 'evidence-one.txt', id: 'file-a' }],
            nextCursor: 'opaque-files-cursor',
          },
        });
      }
      if (!continuationOnline) return json(route, 503, { error: 'Files continuation offline' });
      return json(route, 200, {
        files: {
          items: [
            { filename: 'duplicate-one.txt', id: 'file-a' },
            { filename: 'evidence-two.txt', id: 'file-b' },
          ],
        },
      });
    });

    await page.goto(
      `${BASE_URL}/#/cards?cardId=${encodeURIComponent(card.id)}&taskId=${encodeURIComponent(taskId)}`,
    );
    const files = page.locator('#task-panel .task-file-list');
    const failure = files.locator('.task-file-error');
    await expect(failure).toContainText('More files are available');
    await expect(failure).toContainText('Files continuation offline');
    await expect(files.locator('.task-file-item span')).toHaveText([
      'evidence-one.txt',
    ]);
    await expect(failure.getByRole('button', { name: 'Retry loading files' })).toBeVisible();
    await captureDesktopAndMobile(page, 'task-files-continuation-failure');

    continuationOnline = true;
    await keyboardRetry(
      page,
      failure.getByRole('button', { name: 'Retry loading files' }),
      page.waitForResponse((response) =>
        Boolean(new URL(response.url()).searchParams.get('cursor')),
      ),
    );
    await expect(files.locator('.task-file-error')).toHaveCount(0);
    await expect(files.locator('.task-file-item span')).toHaveText([
      'evidence-one.txt',
      'evidence-two.txt',
    ]);
    await captureDesktopAndMobile(page, 'task-files-duplicate-free-recovery');
  });

  test('Notifications keep rows after a failed next page and retry cleanly', async ({ page }) => {
    let continuationOnline = false;
    const notification = (id, message) => ({
      createdAt:
        id === 'notification-a'
          ? '2026-08-25T10:00:00Z'
          : id === 'notification-c'
            ? '2026-08-26T11:00:00Z'
            : '2026-08-26T10:00:00Z',
      dismissed: false,
      id,
      message,
    });
    await page.route('**/work/api/notifications*', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (!cursor) {
        return json(route, 200, {
          notifications: {
            items: [
              notification('notification-b', 'Notification page one newer'),
              notification('notification-a', 'Notification page one older'),
            ],
            nextCursor: 'opaque-notifications-cursor',
          },
        });
      }
      if (!continuationOnline) return json(route, 503, { error: 'Notifications continuation offline' });
      return json(route, 200, {
        notifications: {
          items: [
            notification('notification-a', 'Duplicate older notification'),
            notification('notification-c', 'Notification page two'),
          ],
        },
      });
    });

    await page.goto(`${BASE_URL}/#/notifications`);
    const messages = page.locator('.work-bell-item-message span:not([aria-hidden])');
    await expect(messages).toHaveText([
      'Notification page one newer',
      'Notification page one older',
    ]);
    await expect(page.locator('.work-bell-continuation')).toContainText(
      'More notifications are available.',
    );
    await captureDesktopAndMobile(page, 'notifications-more-available');

    await keyboardRetry(
      page,
      page.getByRole('button', { name: 'Load more' }),
      page.waitForResponse((response) =>
        Boolean(new URL(response.url()).searchParams.get('cursor')),
      ),
    );
    const failure = page.locator('.work-bell-item-error');
    await expect(failure).toContainText('More notifications are available, but loading failed');
    await expect(messages).toHaveText([
      'Notification page one newer',
      'Notification page one older',
    ]);
    await captureDesktopAndMobile(page, 'notifications-continuation-failure');

    continuationOnline = true;
    await keyboardRetry(
      page,
      page.getByRole('button', { name: 'Retry next page' }),
      page.waitForResponse((response) =>
        Boolean(new URL(response.url()).searchParams.get('cursor')),
      ),
    );
    await expect(messages).toHaveText([
      'Notification page two',
      'Notification page one newer',
      'Notification page one older',
    ]);
    await expect(page.locator('.work-bell-continuation')).toContainText(
      'All notifications loaded.',
    );
    await captureDesktopAndMobile(page, 'notifications-duplicate-free-recovery');
  });

  test('Sponsor booking alerts preserve pages through a failed continuation', async ({ page }) => {
    let continuationOnline = false;
    const alert = (id, message) => ({
      dismissed: false,
      dueAt: '2026-08-30',
      id,
      message,
      metadata: { sponsorBookingId: 'booking-pagination' },
    });
    await page.route('**/work/api/notifications*', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (!cursor) {
        return json(route, 200, {
          notifications: {
            items: [alert('alert-a', 'Sponsor alert one'), alert('alert-b', 'Sponsor alert two')],
            nextCursor: 'opaque-sponsor-alerts-cursor',
          },
        });
      }
      if (!continuationOnline) return json(route, 503, { error: 'Sponsor alerts continuation offline' });
      return json(route, 200, {
        notifications: {
          items: [
            alert('alert-a', 'Duplicate sponsor alert'),
            alert('alert-c', 'Sponsor alert three'),
          ],
        },
      });
    });
    await page.route('**/work/api/sponsor-crm/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/organizations')) {
        return json(route, 200, { items: [{ displayName: 'Pagination Sponsor', id: 'sponsor-org' }] });
      }
      if (pathname.endsWith('/contacts')) return json(route, 200, { items: [] });
      if (pathname.endsWith('/bookings')) {
        return json(route, 200, {
          items: [{
            id: 'booking-pagination',
            organizationId: 'sponsor-org',
            status: 'confirmed',
          }],
        });
      }
      return json(route, 404, { error: 'Unexpected sponsor route' });
    });

    await page.goto(`${BASE_URL}/#/sponsors`);
    const alerts = page.locator('[data-crm-alerts]');
    const articles = alerts.locator('article.crm-card strong');
    await expect(articles).toHaveText(['Sponsor alert one', 'Sponsor alert two']);
    await expect(alerts).toContainText('More booking alerts are available.');
    await captureDesktopAndMobile(page, 'sponsor-alerts-more-available');

    await keyboardRetry(
      page,
      alerts.getByRole('button', { name: 'Load more alerts' }),
      page.waitForResponse((response) =>
        Boolean(new URL(response.url()).searchParams.get('cursor')),
      ),
    );
    await expect(alerts.locator('strong[role="alert"]')).toContainText(
      'More alerts are available, but loading failed',
    );
    await expect(articles).toHaveText(['Sponsor alert one', 'Sponsor alert two']);
    await captureDesktopAndMobile(page, 'sponsor-alerts-continuation-failure');

    continuationOnline = true;
    await keyboardRetry(
      page,
      alerts.getByRole('button', { name: 'Retry next page' }),
      page.waitForResponse((response) =>
        Boolean(new URL(response.url()).searchParams.get('cursor')),
      ),
    );
    await expect(articles).toHaveText([
      'Sponsor alert one',
      'Sponsor alert two',
      'Sponsor alert three',
    ]);
    await expect(alerts).toContainText('All notification pages loaded.');
    await captureDesktopAndMobile(page, 'sponsor-alerts-duplicate-free-recovery');
  });

  test('Mailing Exports keep history after a failed continuation and retry without duplicates', async ({ page }) => {
    let continuationOnline = false;
    const configuration = {
      account: 'Pagination audience',
      enabled: true,
      id: 'mailing-config-pagination',
      provider: 'synthetic',
      scopeLabel: 'All pagination audiences',
    };
    const run = (id, scopeLabel) => ({
      account: 'Pagination audience',
      configId: configuration.id,
      id,
      provider: 'synthetic',
      requestedAt:
        id === 'export-a'
          ? '2026-08-25T09:00:00Z'
          : id === 'export-c'
            ? '2026-08-26T11:00:00Z'
            : '2026-08-26T10:00:00Z',
      scopeLabel,
      status: 'completed',
    });
    await page.route('**/work/api/mailing-exports*', async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (!cursor) {
        return json(route, 200, {
          configs: [configuration],
          exports: {
            items: [run('export-b', 'History page one newer')],
            nextCursor: 'opaque-mailing-cursor',
          },
        });
      }
      if (!continuationOnline) return json(route, 503, { error: 'Mailing continuation offline' });
      return json(route, 200, {
        configs: [configuration],
        exports: {
          items: [
            run('export-a', 'Duplicate history page'),
            run('export-c', 'History page two'),
          ],
        },
      });
    });

    await page.goto(`${BASE_URL}/#/mailing-exports`);
    const history = page.locator('.mailing-export-history');
    await expect(history).toHaveCount(1);
    await expect(history).toContainText('History page one newer');
    await expect(page.getByRole('status')).toContainText('More export history is available.');
    await captureDesktopAndMobile(page, 'mailing-exports-more-available');

    await keyboardRetry(
      page,
      page.getByRole('button', { name: 'Load more' }),
      page.waitForResponse((response) =>
        Boolean(new URL(response.url()).searchParams.get('cursor')),
      ),
    );
    await expect(page.getByRole('alert').filter({ hasText: 'More export history is available, but loading failed' })).toBeVisible();
    await expect(history).toHaveCount(1);
    await captureDesktopAndMobile(page, 'mailing-exports-continuation-failure');

    continuationOnline = true;
    await keyboardRetry(
      page,
      page.getByRole('button', { name: 'Retry next page' }),
      page.waitForResponse((response) =>
        Boolean(new URL(response.url()).searchParams.get('cursor')),
      ),
    );
    await expect(history).toHaveCount(3);
    await expect(history.nth(0)).toContainText('History page two');
    await expect(history.nth(1)).toContainText('History page one newer');
    await expect(history.nth(2)).toContainText('Duplicate history page');
    await expect(page.getByRole('status')).toContainText('All export history loaded.');
    await captureDesktopAndMobile(page, 'mailing-exports-duplicate-free-recovery');
  });
});
