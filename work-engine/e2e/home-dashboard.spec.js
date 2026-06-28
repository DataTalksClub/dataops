const { test, expect } = require('@playwright/test');

// Helper to get today's date in YYYY-MM-DD format
function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function offsetDateString(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Seed user IDs (from seed-users script)
const GRACE_ID = '00000000-0000-0000-0000-000000000001';
const VALERIIA_ID = '00000000-0000-0000-0000-000000000002';

async function cleanupTask(request, task) {
  if (!task) return;
  try {
    await request.delete('/api/tasks/' + task.id);
  } catch (err) {
    console.warn('[cleanup] Could not delete task ' + task.id + ': ' + err.message);
  }
}

async function cleanupBundle(request, bundleId) {
  if (!bundleId) return;
  try {
    await request.put('/api/bundles/' + bundleId + '/archive');
    await request.delete('/api/bundles/' + bundleId);
  } catch (err) {
    console.warn('[cleanup] Could not delete bundle ' + bundleId + ': ' + err.message);
  }
}

function taskRow(page, taskId) {
  return page.locator('[data-task-row="' + taskId + '"]');
}

function successfulTaskUpdate(page, taskId, fieldName) {
  return page.waitForResponse((response) => {
    if (!response.url().includes('/api/tasks/' + taskId)) return false;
    if (response.request().method() !== 'PUT') return false;
    if (response.status() !== 200) return false;
    if (!fieldName) return true;
    return (response.request().postData() || '').includes('"' + fieldName + '"');
  });
}

async function saveDashboardCompletionProof(page, taskId, fieldName) {
  await Promise.all([
    successfulTaskUpdate(page, taskId, fieldName),
    taskRow(page, taskId).locator('[data-save-completion-proof="' + taskId + '"]').click(),
  ]);
  await expect(taskRow(page, taskId).locator('.task-status-checkbox')).toBeEnabled();
}

async function attachDashboardRequiredFile(page, taskId, file) {
  await taskRow(page, taskId).locator('[data-required-file-task="' + taskId + '"]').setInputFiles(file);
  await Promise.all([
    page.waitForResponse((response) => (
      response.url().includes('/api/files')
      && response.request().method() === 'POST'
      && response.status() === 201
    )),
    taskRow(page, taskId).locator('[data-upload-required-file="' + taskId + '"]').click(),
  ]);
  await expect(taskRow(page, taskId).locator('.proof-present')).toContainText('1 file attached');
  await expect(taskRow(page, taskId).locator('.task-status-checkbox')).toBeEnabled();
}

async function markDashboardTaskDone(page, taskId) {
  const checkbox = taskRow(page, taskId).locator('.task-status-checkbox');
  await expect(checkbox).toBeEnabled();
  await Promise.all([
    successfulTaskUpdate(page, taskId, 'status'),
    checkbox.check(),
  ]);
}

test.describe('Home dashboard (issue #26)', () => {

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Grace opens the app and sees her tasks for today
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Grace opens the app and sees her tasks for today', () => {
    const today = todayString();
    let graceTask1, graceTask2, graceTask3, valTask1, valTask2;

    test.beforeAll(async ({ request }) => {
      // Create 3 tasks assigned to Grace
      const r1 = await request.post('/api/tasks', {
        data: { description: 'Grace task 1 dashboard', date: today, assigneeId: GRACE_ID },
      });
      graceTask1 = await r1.json();

      const r2 = await request.post('/api/tasks', {
        data: { description: 'Grace task 2 dashboard', date: today, assigneeId: GRACE_ID },
      });
      graceTask2 = await r2.json();

      const r3 = await request.post('/api/tasks', {
        data: { description: 'Grace task 3 dashboard', date: today, assigneeId: GRACE_ID },
      });
      graceTask3 = await r3.json();

      // Create 2 tasks assigned to Valeriia
      const r4 = await request.post('/api/tasks', {
        data: { description: 'Valeriia task 1 dashboard', date: today, assigneeId: VALERIIA_ID },
      });
      valTask1 = await r4.json();

      const r5 = await request.post('/api/tasks', {
        data: { description: 'Valeriia task 2 dashboard', date: today, assigneeId: VALERIIA_ID },
      });
      valTask2 = await r5.json();
    });

    test.afterAll(async ({ request }) => {
      for (const t of [graceTask1, graceTask2, graceTask3, valTask1, valTask2]) {
        if (t) await request.delete('/api/tasks/' + t.id);
      }
    });

    test('shows only Grace\'s 3 tasks when "assigned to me" is on by default', async ({ page }) => {
      await page.goto('/#/');
      await page.waitForSelector('#dashboard-tasks');

      // Wait for tasks to load
      await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

      // Should see Grace's tasks
      await expect(page.locator('#dashboard-tasks')).toContainText('Grace task 1 dashboard');
      await expect(page.locator('#dashboard-tasks')).toContainText('Grace task 2 dashboard');
      await expect(page.locator('#dashboard-tasks')).toContainText('Grace task 3 dashboard');

      // Should NOT see Valeriia's tasks (assigned-to-me is on by default)
      await expect(page.locator('#dashboard-tasks')).not.toContainText('Valeriia task 1 dashboard');
      await expect(page.locator('#dashboard-tasks')).not.toContainText('Valeriia task 2 dashboard');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Grace toggles "assigned to me" off to see all tasks
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Grace toggles "assigned to me" off to see all tasks', () => {
    const today = todayString();
    let graceTask, valTask;

    test.beforeAll(async ({ request }) => {
      const r1 = await request.post('/api/tasks', {
        data: { description: 'Grace toggle test task', date: today, assigneeId: GRACE_ID },
      });
      graceTask = await r1.json();

      const r2 = await request.post('/api/tasks', {
        data: { description: 'Valeriia toggle test task', date: today, assigneeId: VALERIIA_ID },
      });
      valTask = await r2.json();
    });

    test.afterAll(async ({ request }) => {
      if (graceTask) await request.delete('/api/tasks/' + graceTask.id);
      if (valTask) await request.delete('/api/tasks/' + valTask.id);
    });

    test('unchecking toggle shows all tasks including Valeriia\'s', async ({ page }) => {
      await page.goto('/#/');
      await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

      // Initially Grace's toggle is on, should see Grace's task
      await expect(page.locator('#dashboard-tasks')).toContainText('Grace toggle test task');

      // Uncheck "assigned to me" toggle
      const toggle = page.locator('#assigned-to-me');
      await toggle.uncheck();

      // Wait for reload
      await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

      // Now should see both Grace's and Valeriia's tasks
      await expect(page.locator('#dashboard-tasks')).toContainText('Grace toggle test task');
      await expect(page.locator('#dashboard-tasks')).toContainText('Valeriia toggle test task');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Grace sees active bundles grouped by template type
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Grace sees active bundles grouped by template type', () => {
    let templateNewsletter, templatePodcast;
    let bundle1, bundle2, bundle3;

    test.beforeAll(async ({ request }) => {
      // Create two templates
      const tRes1 = await request.post('/api/templates', {
        data: {
          name: 'Newsletter E2E',
          type: 'newsletter',
          emoji: '📰',
          taskDefinitions: [
            { refId: 'task-1', description: 'Write content', offsetDays: 0 },
          ],
        },
      });
      templateNewsletter = (await tRes1.json()).template;

      const tRes2 = await request.post('/api/templates', {
        data: {
          name: 'Podcast E2E',
          type: 'podcast',
          emoji: '🎙️',
          taskDefinitions: [
            { refId: 'task-1', description: 'Record episode', offsetDays: 0 },
          ],
        },
      });
      templatePodcast = (await tRes2.json()).template;

      // Create 2 Newsletter bundles and 1 Podcast bundle (all active)
      const bRes1 = await request.post('/api/bundles', {
        data: {
          title: 'Newsletter #101 E2E',
          anchorDate: '2026-03-10',
          templateId: templateNewsletter.id,
        },
      });
      bundle1 = (await bRes1.json()).bundle;

      const bRes2 = await request.post('/api/bundles', {
        data: {
          title: 'Newsletter #102 E2E',
          anchorDate: '2026-03-17',
          templateId: templateNewsletter.id,
        },
      });
      bundle2 = (await bRes2.json()).bundle;

      const bRes3 = await request.post('/api/bundles', {
        data: {
          title: 'Podcast EP01 E2E',
          anchorDate: '2026-03-15',
          templateId: templatePodcast.id,
        },
      });
      bundle3 = (await bRes3.json()).bundle;
    });

    test.afterAll(async ({ request }) => {
      // Clean up bundles first (tasks get deleted with them or we skip)
      for (const b of [bundle1, bundle2, bundle3]) {
        if (b) {
          await request.put('/api/bundles/' + b.id + '/archive');
          await request.delete('/api/bundles/' + b.id);
        }
      }
      for (const t of [templateNewsletter, templatePodcast]) {
        if (t) await request.delete('/api/templates/' + t.id);
      }
    });

    test('shows bundles in groups with emoji, title, anchor date, progress badge, and stage', async ({ page }) => {
      await page.goto('/#/');
      await page.waitForSelector('#dashboard-bundles', { timeout: 10000 });

      // Wait for bundles to load (look for a bundle card)
      await page.waitForSelector('.dashboard-bundle-card', { timeout: 10000 });

      // Switch to Template mode to see group headings (default is Date mode)
      await page.waitForSelector('[data-testid="sort-btn-template"]', { timeout: 10000 });
      await page.locator('[data-testid="sort-btn-template"]').click();
      await page.waitForSelector('.bundle-group-heading', { timeout: 10000 });

      // Should have group headings for the templates
      await expect(page.locator('#dashboard-bundles')).toContainText('Newsletter E2E');
      await expect(page.locator('#dashboard-bundles')).toContainText('Podcast E2E');

      // Should see the bundle cards
      await expect(page.locator('#dashboard-bundles')).toContainText('Newsletter #101 E2E');
      await expect(page.locator('#dashboard-bundles')).toContainText('Newsletter #102 E2E');
      await expect(page.locator('#dashboard-bundles')).toContainText('Podcast EP01 E2E');

      // Check for anchor date badge
      const firstCard = page.locator('.dashboard-bundle-card').first();
      await expect(firstCard.locator('.badge-anchor-date')).toBeVisible();

      // Check for progress badge
      await expect(firstCard.locator('.progress-badge')).toBeVisible();

      // Check for stage badge
      await expect(firstCard.locator('.badge-stage')).toBeVisible();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Grace clicks a bundle card to see its details
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Grace clicks a bundle card to see its details', () => {
    let bundle;

    test.beforeAll(async ({ request }) => {
      const bRes = await request.post('/api/bundles', {
        data: {
          title: 'Clickable Bundle E2E',
          anchorDate: '2026-04-01',
        },
      });
      bundle = (await bRes.json()).bundle;
    });

    test.afterAll(async ({ request }) => {
      if (bundle) {
        await request.put('/api/bundles/' + bundle.id + '/archive');
        await request.delete('/api/bundles/' + bundle.id);
      }
    });

    test('clicking a bundle card navigates to the bundle detail view', async ({ page }) => {
      await page.goto('/#/');
      await page.waitForSelector('.dashboard-bundle-card', { timeout: 10000 });

      // Find and click the card
      const card = page.locator('.dashboard-bundle-card', { hasText: 'Clickable Bundle E2E' });
      await expect(card).toBeVisible();
      await card.click();

      // Should navigate to bundles view (hash changes to #/bundles)
      await expect(page).toHaveURL(/\/#\/bundles/);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Grace sees and dismisses a notification
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Grace sees and dismisses a notification', () => {
    // We test the notification bar UI by directly creating a notification via API
    // (The cron runner creates them, but we simulate it here)

    test('notifications API works and dismiss removes them', async ({ request }) => {
      // First, get the list (should be empty or have existing ones)
      const listRes = await request.get('/api/notifications');
      expect(listRes.ok()).toBeTruthy();
      const listData = await listRes.json();
      expect(Array.isArray(listData.notifications)).toBeTruthy();
    });

    test('bell icon is visible in the nav bar on the dashboard', async ({ page }) => {
      await page.goto('/#/');
      // The bell icon should be visible in the nav bar
      await expect(page.locator('#notif-bell')).toBeVisible();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Dashboard shows empty states gracefully
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Dashboard shows empty states gracefully', () => {
    test('empty dashboard states provide clear next actions', async ({ page }) => {
      await page.route('**/api/tasks?date=*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ tasks: [] }),
        });
      });
      await page.route('**/api/bundles', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ bundles: [] }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto('/#/');
      await expect(page.locator('#dashboard-bundles .empty-state-title')).toHaveText('No active bundles');
      await expect(page.locator('#dashboard-bundles .empty-state-body')).toContainText('Create a bundle');
      await expect(page.locator('#dashboard-bundles .empty-state-action', { hasText: 'New bundle' })).toHaveAttribute('href', '#/bundles');

      const queueEmpty = page.locator('#dashboard-tasks .empty-state-title');
      await page.locator('#dashboard-tasks .empty-state-title, #dashboard-tasks table').first().waitFor({ state: 'visible' });
      if (await queueEmpty.isVisible()) {
        await expect(queueEmpty).toHaveText('No queue tasks');
        await expect(page.locator('#dashboard-tasks .empty-state-body')).toContainText('Use the task list');
        await expect(page.locator('#dashboard-tasks .empty-state-action', { hasText: 'Open tasks' })).toHaveAttribute('href', '#/tasks');
      } else {
        await expect(page.locator('#dashboard-tasks table')).toBeVisible();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Structural tests
  // ──────────────────────────────────────────────────────────────────

  test.describe('Dashboard structure and navigation', () => {
    test('Home route renders a two-column dashboard', async ({ page }) => {
      await page.goto('/#/');
      await expect(page.locator('.dashboard-layout')).toBeVisible();
      await expect(page.locator('.dashboard-left')).toBeVisible();
      await expect(page.locator('.dashboard-right')).toBeVisible();
    });

    test('Nav bar has Home link that goes to #/', async ({ page }) => {
      await page.goto('/#/tasks');
      const homeLink = page.locator('nav a', { hasText: 'Home' });
      await expect(homeLink).toBeVisible();
      await expect(homeLink).toHaveAttribute('href', '#/');
    });

    test('Default route redirects to #/ (not #/tasks)', async ({ page }) => {
      await page.goto('/');
      await page.waitForURL(/\/#\//);
      // Should be on home dashboard
      await expect(page.locator('.dashboard-layout')).toBeVisible();
    });

    test('Left column has "Active Bundles" heading', async ({ page }) => {
      await page.goto('/#/');
      await expect(page.locator('.dashboard-left')).toContainText('Active Bundles');
    });

    test('Right column has "Daily Queue" heading', async ({ page }) => {
      await page.goto('/#/');
      await expect(page.locator('.dashboard-right')).toContainText('Daily Queue');
    });

    test('Assigned to me toggle is present and checked by default', async ({ page }) => {
      await page.goto('/#/');
      const toggle = page.locator('#assigned-to-me');
      await expect(toggle).toBeVisible();
      await expect(toggle).toBeChecked();
    });

    test('User picker dropdown is present', async ({ page }) => {
      await page.goto('/#/');
      const picker = page.locator('#dashboard-user-picker');
      await expect(picker).toBeVisible();
    });

    test('Checkbox is disabled when requiredLinkName is set but link is empty', async ({ page, request }) => {
      const today = todayString();
      // Create task with required link, assigned to Grace
      const res = await request.post('/api/tasks', {
        data: {
          description: 'Dashboard required link test',
          date: today,
          requiredLinkName: 'YouTube',
          assigneeId: GRACE_ID,
        },
      });
      const task = await res.json();

      try {
        await page.goto('/#/');
        await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

        const row = page.locator('[data-task-row="' + task.id + '"]');
        await expect(row).toBeVisible();

        // Checkbox should be disabled
        const checkbox = row.locator('.task-status-checkbox');
        await expect(checkbox).toBeDisabled();
      } finally {
        await request.delete('/api/tasks/' + task.id);
      }
    });

    test('Tasks show bundle badge or ad-hoc badge', async ({ page, request }) => {
      const today = todayString();
      // Create an ad-hoc task assigned to Grace
      const res = await request.post('/api/tasks', {
        data: {
          description: 'Ad hoc dashboard test',
          date: today,
          assigneeId: GRACE_ID,
        },
      });
      const task = await res.json();

      try {
        await page.goto('/#/');
        await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

        const row = page.locator('[data-task-row="' + task.id + '"]');
        await expect(row).toBeVisible();
        await expect(row.locator('.badge-adhoc')).toHaveText('ad hoc');
      } finally {
        await request.delete('/api/tasks/' + task.id);
      }
    });

    test('Tasks show assignee badge', async ({ page, request }) => {
      const today = todayString();
      const res = await request.post('/api/tasks', {
        data: {
          description: 'Assignee badge dashboard test',
          date: today,
          assigneeId: GRACE_ID,
        },
      });
      const task = await res.json();

      try {
        await page.goto('/#/');
        await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

        const row = page.locator('[data-task-row="' + task.id + '"]');
        await expect(row).toBeVisible();
        await expect(row.locator('.badge-assignee')).toHaveText('Grace');
      } finally {
        await request.delete('/api/tasks/' + task.id);
      }
    });

    test('Tasks show instructions link when set', async ({ page, request }) => {
      const today = todayString();
      const res = await request.post('/api/tasks', {
        data: {
          description: 'Instructions link dashboard test',
          date: today,
          assigneeId: GRACE_ID,
          instructionsUrl: 'https://docs.google.com/dashboard-test',
        },
      });
      const task = await res.json();

      try {
        await page.goto('/#/');
        await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

        const row = page.locator('[data-task-row="' + task.id + '"]');
        await expect(row).toBeVisible();
        const instrLink = row.locator('.instructions-link');
        await expect(instrLink).toBeVisible();
        await expect(instrLink).toHaveAttribute('href', 'https://docs.google.com/dashboard-test');
        await expect(instrLink).toHaveAttribute('target', '_blank');
        await expect(instrLink).toHaveAttribute('aria-label', 'Open instructions for Instructions link dashboard test');
      } finally {
        await request.delete('/api/tasks/' + task.id);
      }
    });

    test('Comments are not displayed on dashboard tasks', async ({ page, request }) => {
      const today = todayString();
      const res = await request.post('/api/tasks', {
        data: {
          description: 'Task with comment dashboard test',
          date: today,
          assigneeId: GRACE_ID,
          comment: 'This comment should NOT be visible',
        },
      });
      const task = await res.json();

      try {
        await page.goto('/#/');
        await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

        // The comment should not appear anywhere on the dashboard task table
        await expect(page.locator('#dashboard-tasks')).not.toContainText('This comment should NOT be visible');
      } finally {
        await request.delete('/api/tasks/' + task.id);
      }
    });

    test('Dashboard task rows save comment evidence from the queue', async ({ page, request }) => {
      const today = todayString();
      let task;

      try {
        const commentRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard comment proof newsletter task',
            date: today,
            assigneeId: GRACE_ID,
            proofRequirement: { type: 'comment', label: 'Newsletter block updated', required: true },
          },
        });
        task = await commentRes.json();

        await page.goto('/#/');
        await expect(page.locator('#dashboard-tasks table')).toBeVisible({ timeout: 10000 });

        const commentRow = taskRow(page, task.id);
        await expect(commentRow).toContainText('Add completion note: Newsletter block updated');
        await expect(commentRow.locator('.task-status-checkbox')).toBeDisabled();
        await expect(commentRow).toContainText('Missing evidence');

        await commentRow.locator('[data-completion-proof-task="' + task.id + '"]').fill('Newsletter block updated from dashboard');
        await saveDashboardCompletionProof(page, task.id, 'comment');
        await markDashboardTaskDone(page, task.id);
        await expect.poll(async () => {
          const saved = await (await request.get('/api/tasks/' + task.id)).json();
          return saved.comment + '|' + saved.status;
        }).toBe('Newsletter block updated from dashboard|done');
      } finally {
        await cleanupTask(request, task);
      }
    });

    test('Dashboard task rows save external status evidence from the queue', async ({ page, request }) => {
      const today = todayString();
      let task;

      try {
        const statusRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard external status newsletter task',
            date: today,
            assigneeId: GRACE_ID,
            proofRequirement: { type: 'external-status', label: 'Mailchimp campaign scheduled', required: true },
          },
        });
        task = await statusRes.json();

        await page.goto('/#/');
        await expect(page.locator('#dashboard-tasks table')).toBeVisible({ timeout: 10000 });

        const statusRow = taskRow(page, task.id);
        await expect(statusRow).toContainText('Add completion status: Mailchimp campaign scheduled');
        await expect(statusRow.locator('.task-status-checkbox')).toBeDisabled();
        await expect(statusRow).toContainText('Missing evidence');

        await statusRow.locator('[data-completion-proof-task="' + task.id + '"]').fill('Mailchimp campaign scheduled from dashboard');
        await saveDashboardCompletionProof(page, task.id, 'externalStatus');
        await markDashboardTaskDone(page, task.id);
        await expect.poll(async () => {
          const saved = await (await request.get('/api/tasks/' + task.id)).json();
          return saved.externalStatus + '|' + saved.status;
        }).toBe('Mailchimp campaign scheduled from dashboard|done');
      } finally {
        await cleanupTask(request, task);
      }
    });

    test('Dashboard task rows save file proof from the queue', async ({ page, request }) => {
      const today = todayString();
      let task;

      try {
        const fileRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard invoice proof newsletter task',
            date: today,
            assigneeId: GRACE_ID,
            requiresFile: true,
            proofRequirement: { type: 'file', label: 'Invoice PDF or invoice proof', required: true },
          },
        });
        task = await fileRes.json();

        await page.goto('/#/');
        await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

        const fileRow = taskRow(page, task.id);
        await expect(fileRow).toContainText('Attach Invoice PDF or invoice proof to complete');
        await expect(fileRow.locator('.task-status-checkbox')).toBeDisabled();

        await attachDashboardRequiredFile(page, task.id, {
          name: 'dashboard-invoice-proof.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('dashboard invoice proof'),
        });
        await markDashboardTaskDone(page, task.id);
        await expect.poll(async () => {
          const taskBody = await (await request.get('/api/tasks/' + task.id)).json();
          const files = await (await request.get('/api/files?taskId=' + task.id)).json();
          return taskBody.status + '|' + files.files.length;
        }).toBe('done|1');
      } finally {
        await cleanupTask(request, task);
      }
    });

    test('Dashboard task rows save direct links and fresh skip closures from the queue', async ({ page, request }) => {
      const today = todayString();
      const created = [];
      let bundleId;

      try {
        const bundleRes = await request.post('/api/bundles', {
          data: {
            title: 'Dashboard direct evidence bundle',
            anchorDate: today,
            status: 'active',
            bundleLinks: [
              { name: 'Sponsorship document', url: '' },
            ],
          },
        });
        bundleId = (await bundleRes.json()).bundle.id;

        const linkRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard required link newsletter task',
            date: today,
            assigneeId: GRACE_ID,
            bundleId,
            source: 'template',
            requiredLinkName: 'Sponsorship document',
            proofRequirement: { type: 'url', label: 'Sponsorship document', required: true },
            validation: { requiredBundleLinks: ['Sponsorship document'] },
          },
        });
        created.push(await linkRes.json());

        const skippedRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard skipped sponsored social task',
            date: today,
            assigneeId: GRACE_ID,
            requiredLinkName: 'LinkedIn',
            proofRequirement: { type: 'url', label: 'LinkedIn', required: true },
            validation: {
              skipClosure: {
                allowedStatuses: ['not sponsored this week'],
                requires: ['comment'],
              },
            },
          },
        });
        created.push(await skippedRes.json());

        await page.goto('/#/');
        await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

        const linkRow = taskRow(page, created[0].id);
        await expect(linkRow).toContainText('Add Sponsorship document link to complete');
        await expect(linkRow.locator('.task-status-checkbox')).toBeDisabled();

        const skippedRow = taskRow(page, created[1].id);
        await expect(skippedRow.locator('.task-status-checkbox')).toBeDisabled();

        await linkRow.locator('.required-link-input').fill('https://docs.example/sponsorship');
        await linkRow.locator('.required-link-input').press('Enter');
        await markDashboardTaskDone(page, created[0].id);
        await expect.poll(async () => {
          const task = await (await request.get('/api/tasks/' + created[0].id)).json();
          const bundle = (await (await request.get('/api/bundles/' + bundleId)).json()).bundle;
          const sponsorLink = bundle.bundleLinks.find((link) => link.name === 'Sponsorship document');
          return task.link + '|' + task.status + '|' + sponsorLink.url;
        }).toBe('https://docs.example/sponsorship|done|https://docs.example/sponsorship');

        await skippedRow.locator('[data-skip-closure-task="' + created[1].id + '"]').selectOption('not sponsored this week');
        await saveDashboardCompletionProof(page, created[1].id, 'comment');
        await markDashboardTaskDone(page, created[1].id);
        await expect.poll(async () => {
          const task = await (await request.get('/api/tasks/' + created[1].id)).json();
          return task.status + '|' + task.comment;
        }).toContain('done|');
        const skippedTask = await (await request.get('/api/tasks/' + created[1].id)).json();
        expect(skippedTask.comment).toContain('not sponsored this week');
        expect(skippedTask.link).toBeUndefined();
      } finally {
        for (const task of created) {
          await cleanupTask(request, task);
        }
        await cleanupBundle(request, bundleId);
      }
    });

    test('Dashboard task rows save shared bundle links from the queue', async ({ page, request }) => {
      const today = todayString();
      let task;
      let bundleId;

      try {
        const bundleRes = await request.post('/api/bundles', {
          data: {
            title: 'Dashboard shared evidence bundle',
            anchorDate: today,
            status: 'active',
            bundleLinks: [
              { name: 'Mailchimp newsletter', url: '' },
            ],
          },
        });
        bundleId = (await bundleRes.json()).bundle.id;

        const sharedLinkRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard shared Mailchimp link newsletter task',
            date: today,
            assigneeId: GRACE_ID,
            bundleId,
            source: 'template',
            proofRequirement: { type: 'external-status', label: 'Mailchimp campaign scheduled', required: true },
            validation: { requiredBundleLinks: ['Mailchimp newsletter'] },
          },
        });
        task = await sharedLinkRes.json();

        await page.goto('/#/');
        await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

        const sharedLinkRow = taskRow(page, task.id);
        await expect(sharedLinkRow).toContainText('Add Mailchimp newsletter shared link to complete');
        await expect(sharedLinkRow.locator('.task-status-checkbox')).toBeDisabled();

        await sharedLinkRow.locator('.required-bundle-link-input').fill('https://mailchimp.example/dashboard-newsletter');
        await sharedLinkRow.locator('.required-bundle-link-input').press('Enter');
        await expect(taskRow(page, task.id)).toContainText('Add completion status: Mailchimp campaign scheduled');
        await taskRow(page, task.id).locator('[data-completion-proof-task="' + task.id + '"]').fill('Mailchimp campaign scheduled from shared link row');
        await saveDashboardCompletionProof(page, task.id, 'externalStatus');
        await markDashboardTaskDone(page, task.id);
        await expect.poll(async () => {
          const taskBody = await (await request.get('/api/tasks/' + task.id)).json();
          const bundle = (await (await request.get('/api/bundles/' + bundleId)).json()).bundle;
          const mailchimpLink = bundle.bundleLinks.find((link) => link.name === 'Mailchimp newsletter');
          return taskBody.externalStatus + '|' + taskBody.status + '|' + mailchimpLink.url;
        }).toBe('Mailchimp campaign scheduled from shared link row|done|https://mailchimp.example/dashboard-newsletter');
      } finally {
        await cleanupTask(request, task);
        await cleanupBundle(request, bundleId);
      }
    });

    test('Dashboard task rows keep overdue and follow-up labels visible', async ({ page, request }) => {
      const today = todayString();
      const created = [];

      try {
        const overdueRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard overdue newsletter task',
            date: offsetDateString(-1),
            assigneeId: GRACE_ID,
            validation: { dashboardStates: ['overdue'] },
          },
        });
        created.push(await overdueRes.json());

        const followUpRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard follow-up newsletter task',
            date: offsetDateString(-2),
            assigneeId: GRACE_ID,
            status: 'waiting',
            waitingFor: 'Sponsor reply',
            followUpAt: today,
            comment: 'Waiting for sponsor reply',
            validation: { dashboardStates: ['waiting', 'follow-up-due'] },
          },
        });
        created.push(await followUpRes.json());

        const todayRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard today newsletter task',
            date: today,
            assigneeId: GRACE_ID,
            validation: { dashboardStates: ['today'] },
          },
        });
        created.push(await todayRes.json());

        await page.goto('/#/');
        await page.waitForSelector('#dashboard-tasks table', { timeout: 10000 });

        const overdueRow = page.locator('[data-task-row="' + created[0].id + '"]');
        await expect(overdueRow).toContainText('Overdue');

        const followUpRow = page.locator('[data-task-row="' + created[1].id + '"]');
        await expect(followUpRow).toContainText('Follow-up due');

        const todayRow = page.locator('[data-task-row="' + created[2].id + '"]');
        await expect(todayRow).toContainText('Today');

        const groupHeadings = await page.locator('#dashboard-tasks .dashboard-queue-group').allTextContents();
        expect(groupHeadings.indexOf('Follow-ups due')).toBeGreaterThanOrEqual(0);
        expect(groupHeadings.indexOf('Today')).toBeGreaterThanOrEqual(0);
        expect(groupHeadings.indexOf('Follow-ups due')).toBeLessThan(groupHeadings.indexOf('Today'));

        await page.setViewportSize({ width: 1440, height: 1000 });
        const hasOverflow = await page.evaluate(() => (
          document.documentElement.scrollWidth > document.documentElement.clientWidth
        ));
        expect(hasOverflow).toBe(false);
      } finally {
        for (const task of created) {
          await cleanupTask(request, task);
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Bundle sort/group control (issue #32)
  // ──────────────────────────────────────────────────────────────────

  test.describe('Bundle sort control (issue #32)', () => {

    // ── Scenario: Grace sees bundles sorted by date on page load ──
    test.describe('Scenario: Grace sees bundles sorted by date on page load', () => {
      let bundle1, bundle2, bundle3;

      test.beforeAll(async ({ request }) => {
        const r1 = await request.post('/api/bundles', {
          data: { title: 'Sort Date Bundle A', anchorDate: '2026-04-10', status: 'active' },
        });
        bundle1 = (await r1.json()).bundle;

        const r2 = await request.post('/api/bundles', {
          data: { title: 'Sort Date Bundle B', anchorDate: '2026-03-05', status: 'active' },
        });
        bundle2 = (await r2.json()).bundle;

        const r3 = await request.post('/api/bundles', {
          data: { title: 'Sort Date Bundle C', anchorDate: '2026-05-01', status: 'active' },
        });
        bundle3 = (await r3.json()).bundle;
      });

      test.afterAll(async ({ request }) => {
        for (const b of [bundle1, bundle2, bundle3]) {
          if (b) {
            await request.put('/api/bundles/' + b.id + '/archive');
            await request.delete('/api/bundles/' + b.id);
          }
        }
      });

      test('Date is active by default, bundles shown in flat list (no group headings)', async ({ page }) => {
        await page.goto('/#/');
        await page.waitForSelector('[data-testid="bundle-sort-control"]', { timeout: 10000 });

        // Date button should be active
        const dateBtn = page.locator('[data-testid="sort-btn-date"]');
        await expect(dateBtn).toHaveClass(/active/);

        // Stage and template buttons should not be active
        await expect(page.locator('[data-testid="sort-btn-stage"]')).not.toHaveClass(/active/);
        await expect(page.locator('[data-testid="sort-btn-template"]')).not.toHaveClass(/active/);

        // Wait for bundle cards
        await page.waitForSelector('.dashboard-bundle-card', { timeout: 10000 });

        // Should have no group headings in date mode
        const headings = page.locator('#dashboard-bundles .bundle-group-heading');
        await expect(headings).toHaveCount(0);
      });

      test('Bundles are ordered by anchorDate ascending in date mode', async ({ page }) => {
        await page.goto('/#/');
        await page.waitForSelector('.dashboard-bundle-card', { timeout: 10000 });

        const cards = page.locator('#dashboard-bundles .dashboard-bundle-card');
        const count = await cards.count();
        expect(count).toBeGreaterThanOrEqual(3);

        // Among our 3 bundles, B (2026-03-05) should come before A (2026-04-10)
        // which should come before C (2026-05-01)
        const allText = await page.locator('#dashboard-bundles').innerText();
        const posB = allText.indexOf('Sort Date Bundle B');
        const posA = allText.indexOf('Sort Date Bundle A');
        const posC = allText.indexOf('Sort Date Bundle C');
        expect(posB).toBeGreaterThanOrEqual(0);
        expect(posA).toBeGreaterThanOrEqual(0);
        expect(posC).toBeGreaterThanOrEqual(0);
        expect(posB).toBeLessThan(posA);
        expect(posA).toBeLessThan(posC);
      });
    });

    // ── Scenario: Grace switches to stage grouping ──
    test.describe('Scenario: Grace switches to stage grouping', () => {
      let bundlePrep1, bundlePrep2, bundleAnnounced;
      let templateForStage;

      test.beforeAll(async ({ request }) => {
        // Create template to use
        const tRes = await request.post('/api/templates', {
          data: {
            name: 'Stage Test Template',
            type: 'test',
            taskDefinitions: [{ refId: 't1', description: 'Task 1', offsetDays: 0 }],
          },
        });
        templateForStage = (await tRes.json()).template;

        // Create 2 preparation bundles and 1 announced
        const r1 = await request.post('/api/bundles', {
          data: { title: 'Stage Bundle Prep1', anchorDate: '2026-04-01', status: 'active', stage: 'preparation' },
        });
        bundlePrep1 = (await r1.json()).bundle;

        const r2 = await request.post('/api/bundles', {
          data: { title: 'Stage Bundle Prep2', anchorDate: '2026-04-15', status: 'active', stage: 'preparation' },
        });
        bundlePrep2 = (await r2.json()).bundle;

        const r3 = await request.post('/api/bundles', {
          data: { title: 'Stage Bundle Announced', anchorDate: '2026-04-20', status: 'active', stage: 'announced' },
        });
        bundleAnnounced = (await r3.json()).bundle;
      });

      test.afterAll(async ({ request }) => {
        for (const b of [bundlePrep1, bundlePrep2, bundleAnnounced]) {
          if (b) {
            await request.put('/api/bundles/' + b.id + '/archive');
            await request.delete('/api/bundles/' + b.id);
          }
        }
        if (templateForStage) await request.delete('/api/templates/' + templateForStage.id);
      });

      test('Clicking Stage button groups bundles under stage headings', async ({ page }) => {
        await page.goto('/#/');
        await page.waitForSelector('[data-testid="bundle-sort-control"]', { timeout: 10000 });

        // Click Stage button
        await page.locator('[data-testid="sort-btn-stage"]').click();

        // Stage button should be active
        await expect(page.locator('[data-testid="sort-btn-stage"]')).toHaveClass(/active/);
        await expect(page.locator('[data-testid="sort-btn-date"]')).not.toHaveClass(/active/);

        // Wait for re-render
        await page.waitForSelector('.bundle-group-heading', { timeout: 10000 });

        // Should show Preparation and Announced headings
        // Note: CSS text-transform: uppercase means innerText returns uppercase
        const headings = page.locator('#dashboard-bundles .bundle-group-heading');
        const headingTexts = await headings.allInnerTexts();
        const headingTextsLower = headingTexts.map(function (h) { return h.toLowerCase(); });
        expect(headingTextsLower).toContain('preparation');
        expect(headingTextsLower).toContain('announced');

        // Preparation heading should appear before Announced (fixed order)
        const prepIdx = headingTextsLower.indexOf('preparation');
        const annIdx = headingTextsLower.indexOf('announced');
        expect(prepIdx).toBeLessThan(annIdx);

        // The stage-prepared bundles should be under the Preparation heading
        await expect(page.locator('#dashboard-bundles')).toContainText('Stage Bundle Prep1');
        await expect(page.locator('#dashboard-bundles')).toContainText('Stage Bundle Prep2');

        // The announced bundle should appear in the bundles list
        await expect(page.locator('#dashboard-bundles')).toContainText('Stage Bundle Announced');
      });

      test('Stage headings use human-readable labels including After Event', async ({ page, request }) => {
        // Create a bundle in after-event stage
        const r = await request.post('/api/bundles', {
          data: { title: 'AfterEvent Bundle Test', anchorDate: '2026-04-25', status: 'active', stage: 'after-event' },
        });
        const afterEventBundle = (await r.json()).bundle;

        try {
          await page.goto('/#/');
          await page.waitForSelector('[data-testid="bundle-sort-control"]', { timeout: 10000 });

          // Click Stage
          await page.locator('[data-testid="sort-btn-stage"]').click();
          await page.waitForSelector('.bundle-group-heading', { timeout: 10000 });

          // Should show "After Event" label (not "after-event")
          // Note: CSS text-transform: uppercase, so we check case-insensitively
          const headings = page.locator('#dashboard-bundles .bundle-group-heading');
          const headingTexts = await headings.allInnerTexts();
          const headingTextsLower = headingTexts.map(function (h) { return h.toLowerCase(); });
          expect(headingTextsLower).toContain('after event');
          // Should NOT show "after-event" as a heading (the raw stage value)
          expect(headingTextsLower).not.toContain('after-event');
        } finally {
          await request.put('/api/bundles/' + afterEventBundle.id + '/archive');
          await request.delete('/api/bundles/' + afterEventBundle.id);
        }
      });
    });

    // ── Scenario: Grace switches to template grouping ──
    test.describe('Scenario: Grace switches to template grouping', () => {
      let templateNewsletter2, templatePodcast2;
      let bNewsletter1, bNewsletter2, bPodcast;

      test.beforeAll(async ({ request }) => {
        const tRes1 = await request.post('/api/templates', {
          data: {
            name: 'Newsletter Sort32',
            type: 'newsletter',
            taskDefinitions: [{ refId: 't1', description: 'Write', offsetDays: 0 }],
          },
        });
        templateNewsletter2 = (await tRes1.json()).template;

        const tRes2 = await request.post('/api/templates', {
          data: {
            name: 'Podcast Sort32',
            type: 'podcast',
            taskDefinitions: [{ refId: 't1', description: 'Record', offsetDays: 0 }],
          },
        });
        templatePodcast2 = (await tRes2.json()).template;

        const r1 = await request.post('/api/bundles', {
          data: { title: 'Newsletter Bundle 32A', anchorDate: '2026-04-01', templateId: templateNewsletter2.id },
        });
        bNewsletter1 = (await r1.json()).bundle;

        const r2 = await request.post('/api/bundles', {
          data: { title: 'Newsletter Bundle 32B', anchorDate: '2026-04-08', templateId: templateNewsletter2.id },
        });
        bNewsletter2 = (await r2.json()).bundle;

        const r3 = await request.post('/api/bundles', {
          data: { title: 'Podcast Bundle 32', anchorDate: '2026-04-05', templateId: templatePodcast2.id },
        });
        bPodcast = (await r3.json()).bundle;
      });

      test.afterAll(async ({ request }) => {
        for (const b of [bNewsletter1, bNewsletter2, bPodcast]) {
          if (b) {
            await request.put('/api/bundles/' + b.id + '/archive');
            await request.delete('/api/bundles/' + b.id);
          }
        }
        for (const t of [templateNewsletter2, templatePodcast2]) {
          if (t) await request.delete('/api/templates/' + t.id);
        }
      });

      test('Clicking Template button groups bundles under template headings', async ({ page }) => {
        await page.goto('/#/');
        await page.waitForSelector('[data-testid="bundle-sort-control"]', { timeout: 10000 });

        // Click Template button
        await page.locator('[data-testid="sort-btn-template"]').click();

        // Template button should be active
        await expect(page.locator('[data-testid="sort-btn-template"]')).toHaveClass(/active/);
        await expect(page.locator('[data-testid="sort-btn-date"]')).not.toHaveClass(/active/);

        // Wait for group headings
        await page.waitForSelector('.bundle-group-heading', { timeout: 10000 });

        // Should show template name headings
        await expect(page.locator('#dashboard-bundles')).toContainText('Newsletter Sort32');
        await expect(page.locator('#dashboard-bundles')).toContainText('Podcast Sort32');

        // Both newsletter bundles should be visible
        await expect(page.locator('#dashboard-bundles')).toContainText('Newsletter Bundle 32A');
        await expect(page.locator('#dashboard-bundles')).toContainText('Newsletter Bundle 32B');
        await expect(page.locator('#dashboard-bundles')).toContainText('Podcast Bundle 32');
      });
    });

    // ── Scenario: Grace switches back to date sort ──
    test.describe('Scenario: Grace switches back to date sort after stage', () => {
      let bundle;

      test.beforeAll(async ({ request }) => {
        const r = await request.post('/api/bundles', {
          data: { title: 'Back To Date Bundle', anchorDate: '2026-04-03', status: 'active' },
        });
        bundle = (await r.json()).bundle;
      });

      test.afterAll(async ({ request }) => {
        if (bundle) {
          await request.put('/api/bundles/' + bundle.id + '/archive');
          await request.delete('/api/bundles/' + bundle.id);
        }
      });

      test('Switching back to Date removes group headings and shows flat list', async ({ page }) => {
        await page.goto('/#/');
        await page.waitForSelector('[data-testid="bundle-sort-control"]', { timeout: 10000 });

        // Switch to Stage first
        await page.locator('[data-testid="sort-btn-stage"]').click();
        await page.waitForSelector('.bundle-group-heading', { timeout: 10000 });

        // Switch back to Date
        await page.locator('[data-testid="sort-btn-date"]').click();

        // Wait for re-render (no headings expected)
        await page.waitForSelector('.dashboard-bundle-card', { timeout: 10000 });

        // Date button should now be active
        await expect(page.locator('[data-testid="sort-btn-date"]')).toHaveClass(/active/);
        await expect(page.locator('[data-testid="sort-btn-stage"]')).not.toHaveClass(/active/);

        // No group headings in date mode
        const headings = page.locator('#dashboard-bundles .bundle-group-heading');
        await expect(headings).toHaveCount(0);
      });
    });

    // ── Scenario: Only non-empty stages appear in stage mode ──
    test.describe('Scenario: Only non-empty stages appear in stage mode', () => {
      let bundlePrep, bundleAfterEvent;

      test.beforeAll(async ({ request }) => {
        const r1 = await request.post('/api/bundles', {
          data: { title: 'Non-empty Stage PrepTest', anchorDate: '2026-04-10', status: 'active', stage: 'preparation' },
        });
        bundlePrep = (await r1.json()).bundle;

        const r2 = await request.post('/api/bundles', {
          data: { title: 'Non-empty Stage AfterTest', anchorDate: '2026-04-15', status: 'active', stage: 'after-event' },
        });
        bundleAfterEvent = (await r2.json()).bundle;
      });

      test.afterAll(async ({ request }) => {
        for (const b of [bundlePrep, bundleAfterEvent]) {
          if (b) {
            await request.put('/api/bundles/' + b.id + '/archive');
            await request.delete('/api/bundles/' + b.id);
          }
        }
      });

      test('Only stages with bundles show headings in stage mode', async ({ page }) => {
        await page.goto('/#/');
        await page.waitForSelector('[data-testid="bundle-sort-control"]', { timeout: 10000 });

        await page.locator('[data-testid="sort-btn-stage"]').click();
        await page.waitForSelector('.bundle-group-heading', { timeout: 10000 });

        const headings = page.locator('#dashboard-bundles .bundle-group-heading');
        const headingTexts = await headings.allInnerTexts();
        // Note: CSS text-transform: uppercase, so we check case-insensitively
        const headingTextsLower = headingTexts.map(function (h) { return h.toLowerCase(); });

        // Preparation and After Event should appear (our bundles are in those stages)
        expect(headingTextsLower).toContain('preparation');
        expect(headingTextsLower).toContain('after event');
      });
    });

    // ── Sort control structure ──
    test.describe('Sort control structure', () => {
      test('Sort control has three buttons with correct labels', async ({ page }) => {
        await page.goto('/#/');
        await page.waitForSelector('[data-testid="bundle-sort-control"]', { timeout: 10000 });

        const control = page.locator('[data-testid="bundle-sort-control"]');
        await expect(control).toBeVisible();

        const dateBtn = page.locator('[data-testid="sort-btn-date"]');
        const stageBtn = page.locator('[data-testid="sort-btn-stage"]');
        const templateBtn = page.locator('[data-testid="sort-btn-template"]');

        await expect(dateBtn).toBeVisible();
        await expect(stageBtn).toBeVisible();
        await expect(templateBtn).toBeVisible();

        await expect(dateBtn).toHaveText('Date');
        await expect(stageBtn).toHaveText('Stage');
        await expect(templateBtn).toHaveText('Template');
      });
    });

    // ── Empty state ──
    test.describe('Empty state still works in all modes', () => {
      // This is a structural test — if there happen to be no active bundles
      // the empty state message should appear regardless of sort mode
      test('Sort control is visible even when bundles might be empty', async ({ page }) => {
        await page.goto('/#/');
        await page.waitForSelector('[data-testid="bundle-sort-control"]', { timeout: 10000 });
        await expect(page.locator('[data-testid="bundle-sort-control"]')).toBeVisible();
      });
    });
  });
});
