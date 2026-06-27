const { test, expect } = require('@playwright/test');

// Helper: UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('Cron runner API', () => {

  // Scenario: Cron runner creates a bundle for a weekly template
  test('POST /api/cron/run creates a bundle for an automatic template', async ({ request }) => {
    // Create a template with automatic trigger, every day (to guarantee match)
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'Cron Test Newsletter',
        type: 'newsletter',
        triggerType: 'automatic',
        triggerSchedule: '0 9 * * *', // Every day
        triggerLeadDays: 14,
        taskDefinitions: [
          { refId: 'draft', description: 'Write draft', offsetDays: -7 },
          { refId: 'publish', description: 'Publish', offsetDays: 0 },
        ],
      },
    });
    expect(tmplRes.status()).toBe(201);
    const { template } = await tmplRes.json();

    // Run the cron
    const cronRes = await request.post('/api/cron/run');
    expect(cronRes.status()).toBe(200);

    const cronBody = await cronRes.json();
    expect(cronBody.created).toBeDefined();
    expect(Array.isArray(cronBody.created)).toBe(true);
    expect(typeof cronBody.skipped).toBe('number');

    // Find the bundle created for our template
    const bundlesRes = await request.get('/api/bundles');
    const { bundles } = await bundlesRes.json();
    const createdBundle = bundles.find((b) => b.templateId === template.id);

    expect(createdBundle).toBeDefined();
    expect(createdBundle.templateId).toBe(template.id);
    expect(createdBundle.anchorDate).toBeDefined();
    expect(createdBundle.title).toContain('Cron Test Newsletter');

    // Verify tasks were created for this bundle
    const tasksRes = await request.get(`/api/bundles/${createdBundle.id}/tasks`);
    expect(tasksRes.status()).toBe(200);
    const { tasks } = await tasksRes.json();
    expect(tasks.length).toBe(2);
    expect(tasks.every((t) => t.bundleId === createdBundle.id)).toBe(true);

    // Clean up: delete the template
    await request.delete(`/api/templates/${template.id}`);
  });

  // Scenario: Cron runner is idempotent (no duplicates)
  test('POST /api/cron/run is idempotent -- no duplicates on second call', async ({ request }) => {
    // Create a template with automatic trigger
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'Idempotent Test',
        type: 'test',
        triggerType: 'automatic',
        triggerSchedule: '0 9 * * *', // Every day
        triggerLeadDays: 7,
        taskDefinitions: [
          { refId: 'task1', description: 'Task 1', offsetDays: 0 },
        ],
      },
    });
    expect(tmplRes.status()).toBe(201);
    const { template } = await tmplRes.json();

    // First run - should create a bundle
    const firstRun = await request.post('/api/cron/run');
    expect(firstRun.status()).toBe(200);
    const firstBody = await firstRun.json();

    // Get bundle count after first run
    const afterFirst = await request.get('/api/bundles');
    const countAfterFirst = (await afterFirst.json()).bundles.length;

    // Second run - should skip (no duplicates)
    const secondRun = await request.post('/api/cron/run');
    expect(secondRun.status()).toBe(200);
    const secondBody = await secondRun.json();

    // skipped should be >= 1 (our template)
    expect(secondBody.skipped).toBeGreaterThanOrEqual(1);

    // Bundle count should not have increased for our template
    const afterSecond = await request.get('/api/bundles');
    const bundlesAfterSecond = (await afterSecond.json()).bundles;
    const bundlesForTemplate = bundlesAfterSecond.filter(
      (b) => b.templateId === template.id
    );
    expect(bundlesForTemplate.length).toBe(1);

    // Clean up
    await request.delete(`/api/templates/${template.id}`);
  });

  // Scenario: Notification is created when bundle is auto-created
  test('notification is created when bundle is auto-created', async ({ request }) => {
    // Create a template
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'Notification Test Template',
        type: 'test',
        triggerType: 'automatic',
        triggerSchedule: '0 9 * * *', // Every day
        triggerLeadDays: 3,
        taskDefinitions: [
          { refId: 'task1', description: 'Task', offsetDays: 0 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    // Run cron
    await request.post('/api/cron/run');

    // Check notifications
    const notifRes = await request.get('/api/notifications');
    expect(notifRes.status()).toBe(200);

    const { notifications } = await notifRes.json();
    const notification = notifications.find(
      (n) => n.templateId === template.id
    );

    expect(notification).toBeDefined();
    expect(notification.message).toContain('Notification Test Template');
    expect(notification.bundleId).toBeDefined();
    expect(notification.dismissed).toBe(false);

    // Clean up
    await request.delete(`/api/templates/${template.id}`);
  });

  // Scenario: Cron runner skips templates without automatic trigger
  test('cron runner skips templates with manual trigger', async ({ request }) => {
    // Create a manual template
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'Manual Only Template',
        type: 'test',
        triggerType: 'manual',
        taskDefinitions: [
          { refId: 'task1', description: 'Manual task', offsetDays: 0 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    // Run cron
    await request.post('/api/cron/run');

    // Verify no bundle was created for the manual template
    const bundlesRes = await request.get('/api/bundles');
    const { bundles } = await bundlesRes.json();
    const manualBundles = bundles.filter((b) => b.templateId === template.id);

    expect(manualBundles.length).toBe(0);

    // Clean up
    await request.delete(`/api/templates/${template.id}`);
  });
});

test.describe('Notifications API', () => {

  // Scenario: GET /api/notifications returns undismissed notifications
  test('GET /api/notifications returns undismissed notifications sorted by most recent', async ({ request }) => {
    // Ensure at least one notification exists (create via cron)
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'Notif List Test',
        type: 'test',
        triggerType: 'automatic',
        triggerSchedule: '0 9 * * *',
        triggerLeadDays: 0,
        taskDefinitions: [
          { refId: 'task1', description: 'Task', offsetDays: 0 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    await request.post('/api/cron/run');

    const res = await request.get('/api/notifications');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/json');

    const body = await res.json();
    expect(body.notifications).toBeDefined();
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(body.notifications.length).toBeGreaterThan(0);

    // Verify each notification has the expected structure
    for (const n of body.notifications) {
      expect(n.id).toBeDefined();
      expect(n.message).toBeDefined();
      expect(n.dismissed).toBe(false);
      expect(n.createdAt).toBeDefined();
    }

    // Verify sorted by most recent first
    for (let i = 1; i < body.notifications.length; i++) {
      expect(body.notifications[i - 1].createdAt >= body.notifications[i].createdAt).toBe(true);
    }

    // Clean up
    await request.delete(`/api/templates/${template.id}`);
  });

  // Scenario: Dismiss a notification
  test('PUT /api/notifications/:id/dismiss marks notification as dismissed', async ({ request }) => {
    // Create a template and run cron to get a notification
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'Dismiss Test Template',
        type: 'test',
        triggerType: 'automatic',
        triggerSchedule: '0 9 * * *',
        triggerLeadDays: 5,
        taskDefinitions: [
          { refId: 'task1', description: 'Task', offsetDays: 0 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    await request.post('/api/cron/run');

    // Get the notification
    const listRes = await request.get('/api/notifications');
    const { notifications } = await listRes.json();
    const notification = notifications.find((n) => n.templateId === template.id);
    expect(notification).toBeDefined();

    // Dismiss it
    const dismissRes = await request.put(`/api/notifications/${notification.id}/dismiss`);
    expect(dismissRes.status()).toBe(200);

    const dismissBody = await dismissRes.json();
    expect(dismissBody.notification.dismissed).toBe(true);

    // Verify it no longer appears in undismissed list
    const afterRes = await request.get('/api/notifications');
    const afterBody = await afterRes.json();
    const dismissed = afterBody.notifications.find((n) => n.id === notification.id);
    expect(dismissed).toBeUndefined();

    // Clean up
    await request.delete(`/api/templates/${template.id}`);
  });

  test('PUT /api/notifications/:id/dismiss returns 404 for non-existent notification', async ({ request }) => {
    const res = await request.put('/api/notifications/does-not-exist/dismiss');
    expect(res.status()).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Notification not found');
  });
});
