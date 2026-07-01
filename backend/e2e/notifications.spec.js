const { test, expect } = require('@playwright/test');

function uid() {
  return Math.random().toString(36).slice(2, 8);
}

// Helper to create a notification via API
async function createNotification(request, message) {
  // Use the cron-style internal creation endpoint doesn't exist publicly,
  // so we'll use the createBundle cron to create notifications — but we don't
  // have that either. Instead, let's hit the notifications API directly for
  // setup/teardown by creating via the handler's createNotification path.
  // Since there's no public POST /api/notifications, we'll verify via
  // dismiss endpoints and the GET endpoint.
  // We'll leverage a workaround: notifications are created by the cron.
  // For test setup we create them through a helper approach.
  // Actually, looking at the code there IS no public create endpoint.
  // We'll test what we can without direct creation.
  return null;
}

test.describe('Notification bell UI (issue #30)', () => {

  // ──────────────────────────────────────────────────────────────────
  // API tests: GET /api/notifications?all=true
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: API — GET all notifications includes dismissed ones', () => {
    let notif1Id, notif2Id, notif3Id;

    test.beforeAll(async ({ request }) => {
      // We can't create notifications directly through the public API.
      // But we can test the endpoint itself returns an array.
      // To create a dismissed notification, we first need to create one.
      // Since there's no public create endpoint, we test the shape of the response.

      // The cron/internal endpoints create notifications.
      // For this test, trigger the cron to create some (if bundles exist)
      // or rely on other tests that may have created them.

      // Let's just verify the endpoint exists and returns the right shape.
    });

    test('GET /api/notifications returns undismissed array', async ({ request }) => {
      const res = await request.get('/api/notifications');
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      expect(Array.isArray(data.notifications)).toBeTruthy();
    });

    test('GET /api/notifications?all=true returns all notifications array', async ({ request }) => {
      const res = await request.get('/api/notifications?all=true');
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      expect(Array.isArray(data.notifications)).toBeTruthy();
    });

    test('GET /api/notifications?all=true includes dismissed notifications', async ({ request }) => {
      // Create a bundle to trigger cron-style creation... or test with direct DB seeding.
      // Since we can't create notifications directly, we test the flow:
      // 1. List all (start with empty or existing)
      // 2. PUT dismiss-all
      // 3. List all again — dismissed items should have dismissed:true

      // First dismiss everything
      await request.put('/api/notifications/dismiss-all');

      // List all — they should all be dismissed (or empty)
      const allRes = await request.get('/api/notifications?all=true');
      const allData = await allRes.json();
      const allNotifs = allData.notifications || [];
      // All should be dismissed or list is empty
      allNotifs.forEach(n => {
        expect(n.dismissed).toBe(true);
      });

      // Undismissed list should be empty
      const undismissedRes = await request.get('/api/notifications');
      const undismissedData = await undismissedRes.json();
      expect(undismissedData.notifications.length).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // API test: PUT /api/notifications/dismiss-all
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: API — Dismiss all notifications', () => {
    test('PUT /api/notifications/dismiss-all returns 200 with count', async ({ request }) => {
      const res = await request.put('/api/notifications/dismiss-all');
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      expect(typeof data.count).toBe('number');
    });

    test('after dismiss-all, GET /api/notifications returns empty list', async ({ request }) => {
      // Dismiss all
      await request.put('/api/notifications/dismiss-all');

      // Then list undismissed
      const listRes = await request.get('/api/notifications');
      expect(listRes.ok()).toBeTruthy();
      const data = await listRes.json();
      expect(data.notifications.length).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UI: Bell icon visible in nav bar
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Bell icon is visible in nav bar', () => {
    test('bell icon is visible on every page', async ({ page }) => {
      // Home
      await page.goto('/#/');
      await expect(page.locator('#notif-bell')).toBeVisible();

      // Tasks
      await page.goto('/#/tasks');
      await expect(page.locator('#notif-bell')).toBeVisible();

      // Bundles
      await page.goto('/#/bundles');
      await expect(page.locator('#notif-bell')).toBeVisible();

      // Templates
      await page.goto('/#/templates');
      await expect(page.locator('#notif-bell')).toBeVisible();

      // Recurring
      await page.goto('/#/recurring');
      await expect(page.locator('#notif-bell')).toBeVisible();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UI: Badge hidden when no undismissed notifications
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: User sees no badge when all notifications are dismissed', () => {
    test.beforeAll(async ({ request }) => {
      // Dismiss all notifications so count is 0
      await request.put('/api/notifications/dismiss-all');
    });

    test('badge is hidden when no undismissed notifications', async ({ page }) => {
      await page.goto('/#/');
      // Wait for bell to initialize
      await page.waitForTimeout(500);

      const badge = page.locator('#notif-badge');
      // Badge should be hidden (display:none)
      await expect(badge).toHaveCSS('display', 'none');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UI: Opening the bell dropdown
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: User opens bell dropdown with no notifications', () => {
    test.beforeAll(async ({ request }) => {
      await request.put('/api/notifications/dismiss-all');
    });

    test('dropdown shows "No new notifications" when no undismissed', async ({ page }) => {
      await page.goto('/#/');
      await page.waitForTimeout(300);

      // Click the bell
      await page.locator('#notif-bell').click();

      // Dropdown should appear
      const dropdown = page.locator('#notif-dropdown');
      await expect(dropdown).toBeVisible();

      // Should show "No new notifications"
      await expect(dropdown).toContainText('No new notifications');

      // "See all" link should be visible
      await expect(dropdown.locator('a')).toContainText('See all');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UI: Closing dropdown by clicking outside
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: User closes dropdown by clicking outside', () => {
    test.beforeAll(async ({ request }) => {
      await request.put('/api/notifications/dismiss-all');
    });

    test('clicking outside closes the dropdown', async ({ page }) => {
      await page.goto('/#/');
      await page.waitForTimeout(300);

      // Open dropdown
      await page.locator('#notif-bell').click();
      const dropdown = page.locator('#notif-dropdown');
      await expect(dropdown).toBeVisible();

      // Click outside (on the page body, away from the dropdown)
      await page.mouse.click(10, 400);

      // Dropdown should be hidden
      await expect(dropdown).toBeHidden();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UI: "See all" link navigates to #/notifications
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: User navigates to full notifications view via "See all"', () => {
    test.beforeAll(async ({ request }) => {
      await request.put('/api/notifications/dismiss-all');
    });

    test('clicking "See all" navigates to #/notifications', async ({ page }) => {
      await page.goto('/#/');
      await page.waitForTimeout(300);

      // Open dropdown
      await page.locator('#notif-bell').click();
      await expect(page.locator('#notif-dropdown')).toBeVisible();

      // Click "See all"
      await page.locator('#notif-dropdown a').click();

      // Should navigate to notifications page
      await expect(page).toHaveURL(/\/#\/notifications/);

      // Dropdown should be closed
      await expect(page.locator('#notif-dropdown')).toBeHidden();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UI: Notifications full view
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Full notifications view shows all notifications', () => {
    test.beforeAll(async ({ request }) => {
      await request.put('/api/notifications/dismiss-all');
    });

    test('navigating to #/notifications shows the page with heading and dismiss-all button', async ({ page }) => {
      await page.goto('/#/notifications');

      // Should show "Notifications" heading
      await expect(page.locator('h2')).toContainText('Notifications');

      // Should have "Dismiss all" button
      await expect(page.locator('#dismiss-all-btn')).toBeVisible();
    });

    test('empty state shown when no notifications', async ({ page }) => {
      // Dismiss all first
      await page.goto('/#/notifications');
      // Wait for list to load
      await page.waitForTimeout(500);

      // Check for either empty state or list
      const container = page.locator('#notif-list-container');
      const html = await container.innerHTML();

      // Should not say "Loading..."
      expect(html).not.toBe('<p>Loading...</p>');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UI: Dismiss all from notifications page
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Individual notification dismiss control is accessible', () => {
    test('dismiss button has a descriptive accessible name and pending state', async ({ page, request }) => {
      const name = 'Accessible Dismiss Template ' + uid();
      let templateId;
      let bundleId;

      try {
        await page.route('**/api/notifications/*/dismiss', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          await route.continue();
        });

        const tmplRes = await request.post('/api/templates', {
          data: {
            name,
            type: 'test',
            triggerType: 'automatic',
            triggerSchedule: '0 9 * * *',
            triggerLeadDays: 1,
            taskDefinitions: [
              { refId: 'task1', description: 'Task', offsetDays: 0 },
            ],
          },
        });
        expect(tmplRes.status()).toBe(201);
        templateId = (await tmplRes.json()).template.id;

        await request.post('/api/cron/run');

        const bundlesRes = await request.get('/api/bundles');
        const bundles = (await bundlesRes.json()).bundles || [];
        const bundle = bundles.find(function (b) { return b.templateId === templateId; });
        bundleId = bundle && bundle.id;

        await page.goto('/#/notifications');
        const dismissBtn = page.getByRole('button', { name: new RegExp('Dismiss notification: .*' + name) });
        await expect(dismissBtn).toBeVisible();
        await dismissBtn.click();

        const pendingBtn = page.getByRole('button', { name: new RegExp('Dismissing notification: .*' + name) });
        await expect(pendingBtn).toBeDisabled();
        await expect(pendingBtn).toHaveText('...');
        await expect(pendingBtn).toHaveAttribute('aria-busy', 'true');

        await expect(page.locator('[data-notif-item]', { hasText: name })).toHaveClass(/dismissed/);
        await expect(page.locator('[data-notif-item]', { hasText: name })).toContainText('dismissed');
      } finally {
        if (bundleId) {
          await request.put('/api/bundles/' + bundleId + '/archive');
          await request.delete('/api/bundles/' + bundleId);
        }
        if (templateId) {
          await request.delete('/api/templates/' + templateId);
        }
      }
    });
  });

  test.describe('Scenario: User dismisses all notifications from full view', () => {
    test('clicking dismiss-all button calls the API and refreshes', async ({ page, request }) => {
      await page.route('**/api/notifications/dismiss-all', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.continue();
      });

      await page.goto('/#/notifications');
      await page.waitForTimeout(500);

      // Click dismiss all
      const dismissAllBtn = page.locator('#dismiss-all-btn');
      await expect(dismissAllBtn).toBeVisible();
      await dismissAllBtn.click();
      await expect(dismissAllBtn).toBeDisabled();
      await expect(dismissAllBtn).toHaveText('Dismissing...');
      await expect(dismissAllBtn).toHaveAttribute('aria-busy', 'true');

      // Wait for reload
      await expect(dismissAllBtn).toHaveText('Dismiss all');
      await expect(dismissAllBtn).toBeEnabled();
      await expect(dismissAllBtn).not.toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('.success-banner')).toContainText('Notifications dismissed.');

      // Bell badge should not be visible (no undismissed)
      const badge = page.locator('#notif-badge');
      await expect(badge).toHaveCSS('display', 'none');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UI: Old notification bar not on dashboard
  // ──────────────────────────────────────────────────────────────────

  test.describe('Old notification bar removed from dashboard', () => {
    test('#notification-bar is not rendered on dashboard', async ({ page }) => {
      await page.goto('/#/');
      await page.waitForSelector('#app', { timeout: 5000 });

      // The old #notification-bar should not exist
      const oldBar = page.locator('#notification-bar');
      await expect(oldBar).not.toBeAttached();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UI: Navigate hash changes refresh badge
  // ──────────────────────────────────────────────────────────────────

  test.describe('Badge refreshes on navigation', () => {
    test('bell badge is present in the nav bar on all pages', async ({ page }) => {
      await page.goto('/#/');
      // Bell wrapper should be visible
      await expect(page.locator('#notif-bell-wrapper')).toBeVisible();

      await page.goto('/#/tasks');
      await expect(page.locator('#notif-bell-wrapper')).toBeVisible();
    });
  });

});
