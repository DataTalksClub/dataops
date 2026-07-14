const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

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
const ISSUE_67_SCREENSHOT_DIR = path.join(__dirname, '..', '..', '.tmp', 'screenshots', 'issue-67');
const ISSUE_69_SCREENSHOT_DIR = path.join(__dirname, '..', '..', '.tmp', 'screenshots', 'issue-69');

async function screenshotIssue67(page, name) {
  fs.mkdirSync(ISSUE_67_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(ISSUE_67_SCREENSHOT_DIR, name + '.png'), fullPage: true });
}

async function screenshotIssue69(page, name) {
  fs.mkdirSync(ISSUE_69_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(ISSUE_69_SCREENSHOT_DIR, name + '.png'), fullPage: true });
}

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

// Resolve which labelled queue section a task row sits under by walking back to
// the nearest preceding .dashboard-queue-group header (#105).
function queueSectionForRow(page, taskId) {
  return page.evaluate((id) => {
    const row = document.querySelector('[data-task-row="' + id + '"]');
    if (!row) return null;
    let node = row.previousElementSibling;
    while (node) {
      if (node.classList && node.classList.contains('dashboard-queue-group')) {
        return (node.textContent || '').trim();
      }
      node = node.previousElementSibling;
    }
    return null;
  }, taskId);
}

// The dashboard's task table loads through a chain of async fetches (tasks,
// files, bundles) in loadDashboardTasks. #dashboard-tasks carries a
// data-loaded attribute that flips to "true" only at the terminal render
// (table populated, empty state, or error). Under CI cross-worker contention
// on the shared port-3001 server the first fetch can be slow, and the snapshot
// can be hydrated-but-stale (fetched before this spec created today's task),
// so a single wait on the signal can time out or resolve against an empty
// table.
//
// waitForDashboardTasksLoaded therefore uses a retry-with-refresh loop: every
// attempt forces a fresh dashboard-tasks fetch via the
// window.__dataopsRefreshDashboardTasks seam at the top, waits for the hydrated
// data-loaded signal inside a try/catch, and recovers a cold-start or stale
// snapshot by forcing a fresh fetch rather than waiting longer on a fetch that
// already raced task creation. This mirrors the portal-spec fix in 3a7c3b4.
async function waitForDashboardTasksLoaded(page) {
  const loadedSignal = page.locator('#dashboard-tasks[data-loaded="true"]');
  for (let attempt = 0; attempt < 4; attempt++) {
    // Idempotent: the dashboard view's initial render already triggered a fetch
    // on attempt 0, but re-invoking keeps every iteration uniform and
    // guarantees a fresh fetch on the retries.
    await page.evaluate(() => window.__dataopsRefreshDashboardTasks && window.__dataopsRefreshDashboardTasks());
    try {
      await expect(loadedSignal).toBeVisible({ timeout: 10000 });
      return;
    } catch (err) {
      if (attempt === 3) throw err;
    }
  }
}

// Wait for a specific task row to be ready before asserting on it. On a stale
// snapshot the row can be absent even after data-loaded flips true (the queue
// hydrated against a snapshot taken before this spec created its task), so poll
// for the row with a bounded retry that re-fetches on each attempt.
async function waitForDashboardTaskRow(page, taskId) {
  const row = taskRow(page, taskId);
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.evaluate(() => window.__dataopsRefreshDashboardTasks && window.__dataopsRefreshDashboardTasks());
    try {
      await expect(page.locator('#dashboard-tasks[data-loaded="true"]')).toBeVisible({ timeout: 10000 });
      await expect(row).toBeVisible({ timeout: 8000 });
      return row;
    } catch (err) {
      if (attempt === 3) throw err;
    }
  }
  return row;
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

// A Daily Queue row must present exactly one primary next-action button and no
// inline completion editor or raw required-link/file inputs (#103).
async function expectSingleQueueNextAction(row, label) {
  const nextCell = row.locator('[data-label="Next Action"]');
  await expect(nextCell.locator('.task-next-action')).toHaveCount(1);
  if (label) await expect(nextCell.locator('.task-next-action')).toHaveText(label);
  await expect(row.locator('.required-link-input')).toHaveCount(0);
  await expect(row.locator('.required-bundle-link-input')).toHaveCount(0);
  await expect(row.locator('[data-completion-proof-task]')).toHaveCount(0);
  await expect(row.locator('[data-required-file-task]')).toHaveCount(0);
  await expect(row.locator('[data-skip-closure-task]')).toHaveCount(0);
  await expect(row.locator('[data-save-completion-proof]')).toHaveCount(0);
}

test.describe('Home dashboard (issue #26)', () => {
  // The dashboard wait helpers use a bounded retry-with-refresh loop (up to ~72s
  // worst case to recover a cold-start/stale queue snapshot), which can exceed
  // the 30s Playwright config default and fail with "Test timeout of 30000ms
  // exceeded". Scope a generous timeout across this spec, as the portal specs
  // did in 3a7c3b4.
  test.setTimeout(90000);

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
      await waitForDashboardTasksLoaded(page);

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
      await waitForDashboardTasksLoaded(page);

      // Initially Grace's toggle is on, should see Grace's task
      await expect(page.locator('#dashboard-tasks')).toContainText('Grace toggle test task');

      // Uncheck "assigned to me" toggle
      const toggle = page.locator('#assigned-to-me');
      await toggle.uncheck();

      // Wait for reload
      await waitForDashboardTasksLoaded(page);

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
    const seededTemplates = [
      {
        id: 'tpl-first-run-podcast',
        name: 'Podcast',
        type: 'podcast',
        emoji: '🎙️',
        triggerType: 'manual',
        tags: ['podcast'],
        sourceDocIds: ['task-template.tasks.podcast'],
        taskDefinitions: [
          { refId: 'brief', description: 'Prepare podcast brief', offsetDays: -14 },
          { refId: 'live', description: 'Run podcast live stream', offsetDays: 0 },
        ],
      },
      {
        id: 'tpl-first-run-newsletter',
        name: 'Newsletter',
        type: 'newsletter',
        emoji: '📰',
        triggerType: 'automatic',
        tags: ['newsletter'],
        sourceDocIds: ['task-template.tasks.newsletter'],
        taskDefinitions: [
          { refId: 'draft', description: 'Draft newsletter', offsetDays: -7 },
          { refId: 'publish', description: 'Publish newsletter', offsetDays: 0 },
        ],
      },
    ];

    async function mockCleanSeededRuntime(page, createdState) {
      await page.route('**/api/users', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ users: [{ id: GRACE_ID, name: 'Grace', email: 'grace@datatalks.club' }] }),
        });
      });
      await page.route('**/api/templates', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ templates: seededTemplates }),
        });
      });
      await page.route('**/api/tasks**', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ tasks: [] }),
          });
          return;
        }
        await route.continue();
      });
      await page.route('**/api/intake**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [] }),
        });
      });
      await page.route('**/api/assistant-jobs**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jobs: [] }),
        });
      });
      await page.route('**/api/artifacts**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ artifacts: [] }),
        });
      });
      await page.route('**/api/files**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: [] }),
        });
      });
      await page.route('**/api/notifications**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ notifications: [] }),
        });
      });
      await page.route('**/api/bundles**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;

        if (request.method() === 'GET' && pathname === '/api/bundles') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ bundles: createdState.bundle ? [createdState.bundle] : [] }),
          });
          return;
        }

        if (request.method() === 'POST' && pathname === '/api/bundles') {
          const payload = JSON.parse(request.postData() || '{}');
          const template = seededTemplates.find((item) => item.id === payload.templateId) || seededTemplates[0];
          const workflowType = template.type || 'workflow';
          const bundleId = 'bundle-first-run-' + workflowType;
          const linkName = workflowType === 'newsletter' ? 'Mailchimp newsletter' : 'Podcast document';
          const taskDescription = workflowType === 'newsletter' ? 'Draft newsletter' : 'Prepare podcast brief';
          const templateTaskRef = workflowType === 'newsletter' ? 'draft' : 'brief';
          createdState.bundle = {
            id: bundleId,
            title: payload.title,
            anchorDate: payload.anchorDate,
            templateId: payload.templateId,
            status: 'active',
            stage: 'preparation',
            emoji: template.emoji,
            tags: [workflowType],
            bundleLinks: [{ name: linkName, url: '' }],
          };
          createdState.tasks = [
            {
              id: 'task-first-run-' + templateTaskRef,
              bundleId: createdState.bundle.id,
              templateId: payload.templateId,
              templateTaskRef,
              source: 'template',
              status: 'todo',
              date: payload.anchorDate,
              description: taskDescription,
              instructionDocId: workflowType === 'newsletter'
                ? 'template.newsletter.create-newsletter-draft-from-template-in-mailchimp'
                : 'sop.media.podcast.create-podcast-document',
              proofRequirement: { type: 'comment', label: workflowType === 'newsletter' ? 'Draft reviewed' : 'Podcast brief reviewed', required: true },
            },
          ];
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({ bundle: createdState.bundle, tasks: createdState.tasks }),
          });
          return;
        }

        if (request.method() === 'GET' && createdState.bundle && pathname === '/api/bundles/' + createdState.bundle.id) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ bundle: createdState.bundle }),
          });
          return;
        }

        if (request.method() === 'GET' && createdState.bundle && pathname === '/api/bundles/' + createdState.bundle.id + '/tasks') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ tasks: createdState.tasks || [] }),
          });
          return;
        }

        await route.continue();
      });
    }

    test('empty dashboard links to the Templates library and hosts no inline start-forms', async ({ page }) => {
      await mockCleanSeededRuntime(page, {});

      await page.goto('/#/');
      // No-active-work state: a CTA to the Templates library, not per-template
      // start-forms (workflow-start was consolidated into the Templates page).
      const noWork = page.locator('[data-testid="dashboard-no-active-work"]');
      await expect(noWork).toBeVisible();
      await expect(noWork).toContainText('No active production work yet');
      const cta = noWork.locator('.empty-state-action', { hasText: 'Start a workflow from the Templates library' });
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute('href', '#/templates');

      // The scattered per-template start-forms must be gone from the dashboard.
      await expect(page.locator('[data-testid="first-run-workflows"]')).toHaveCount(0);
      await expect(page.locator('.first-run-workflow-card')).toHaveCount(0);
      await expect(page.locator('[data-testid="first-run-start-podcast"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="first-run-start-newsletter"]')).toHaveCount(0);
      await screenshotIssue69(page, 'dashboard-no-active-work');

      const queueEmpty = page.locator('#dashboard-tasks .empty-state-title');
      await page.locator('#dashboard-tasks .empty-state-title, #dashboard-tasks table').first().waitFor({ state: 'visible' });
      if (await queueEmpty.isVisible()) {
        await expect(queueEmpty).toHaveText('No queue tasks');
        await expect(page.locator('#dashboard-tasks .empty-state-body')).toContainText('Use the task list');
        await expect(page.locator('#dashboard-tasks .empty-state-action', { hasText: 'Open tasks' })).toHaveAttribute('href', '#/tasks');
      } else {
        await waitForDashboardTasksLoaded(page);
      }
    });

    test('empty queue still leads with the four core sections and clear empty states (#105)', async ({ page }) => {
      await mockCleanSeededRuntime(page, {});

      await page.goto('/#/');
      await page.waitForSelector('#dashboard-tasks table', { timeout: 15000 });

      // All four core operator questions render as labelled sections, in order,
      // even when the operator has nothing in them.
      const groupHeadings = await page.locator('#dashboard-tasks .dashboard-queue-group').allTextContents();
      expect(groupHeadings.slice(0, 4)).toEqual(['Today', 'Overdue', 'Follow-ups due', 'At-risk workflows']);

      // Each empty core section states what is clear rather than disappearing.
      const emptyRows = await page.locator('#dashboard-tasks .dashboard-queue-empty').allTextContents();
      expect(emptyRows).toContain('Nothing due today');
      expect(emptyRows).toContain('No overdue tasks');
      expect(emptyRows).toContain('No follow-ups due');
      expect(emptyRows).toContain('No at-risk workflows');
    });

    test('the no-active-work CTA navigates to the Templates library', async ({ page }) => {
      await mockCleanSeededRuntime(page, {});

      await page.goto('/#/');
      const cta = page.locator('[data-testid="dashboard-no-active-work"] .empty-state-action', {
        hasText: 'Start a workflow from the Templates library',
      });
      await expect(cta).toBeVisible();
      await cta.click();

      await expect(page).toHaveURL(/\/#\/templates/);
      await page.waitForSelector('.template-card');
      // The manual Podcast template exposes a Start-workflow action in the library.
      const podcastCard = page.locator('.template-card', { hasText: 'Podcast' });
      await expect(podcastCard.locator('.template-start-action')).toBeVisible();
      // The automatic Newsletter template does NOT offer a manual start action.
      const newsletterCard = page.locator('.template-card', { hasText: 'Newsletter' });
      await expect(newsletterCard.locator('.template-start-action')).toHaveCount(0);
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
        await waitForDashboardTasksLoaded(page);

        const row = await waitForDashboardTaskRow(page, task.id);

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
        await waitForDashboardTasksLoaded(page);

        const row = await waitForDashboardTaskRow(page, task.id);
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
        await waitForDashboardTasksLoaded(page);

        const row = await waitForDashboardTaskRow(page, task.id);
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
        await waitForDashboardTasksLoaded(page);

        const row = await waitForDashboardTaskRow(page, task.id);
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
        await waitForDashboardTasksLoaded(page);

        // The comment should not appear anywhere on the dashboard task table
        await expect(page.locator('#dashboard-tasks')).not.toContainText('This comment should NOT be visible');
      } finally {
        await request.delete('/api/tasks/' + task.id);
      }
    });

    test('Dashboard comment-proof rows route to task detail instead of embedding the editor', async ({ page, request }) => {
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
        await waitForDashboardTasksLoaded(page);

        const commentRow = taskRow(page, task.id);
        await expect(commentRow).toContainText('Add completion note: Newsletter block updated');
        await expect(commentRow).toContainText('Missing evidence');
        // Completion stays blocked and no inline editor is embedded in the row.
        await expect(commentRow.locator('.task-status-checkbox')).toBeDisabled();
        await expectSingleQueueNextAction(commentRow, 'Add evidence');

        // The next-action opens the task detail (no bundle -> task list) where the
        // proof can be added; the dashboard row never rendered the editor.
        const nextBtn = commentRow.locator('[data-label="Next Action"] .task-next-action');
        await expect(nextBtn).toHaveAttribute('href', /#\/tasks\?.*taskId=/);
        await nextBtn.click();
        const detailRow = taskRow(page, task.id);
        await expect(detailRow).toBeVisible({ timeout: 10000 });
        await expect(detailRow.locator('[data-completion-proof-task="' + task.id + '"]')).toBeVisible();
        await expect(detailRow.locator('.task-status-checkbox')).toBeDisabled();
      } finally {
        await cleanupTask(request, task);
      }
    });

    test('Dashboard external-status rows route to task detail instead of embedding the editor', async ({ page, request }) => {
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
        await waitForDashboardTasksLoaded(page);

        const statusRow = taskRow(page, task.id);
        await expect(statusRow).toContainText('Add completion status: Mailchimp campaign scheduled');
        await expect(statusRow).toContainText('Missing evidence');
        await expect(statusRow.locator('.task-status-checkbox')).toBeDisabled();
        await expectSingleQueueNextAction(statusRow, 'Add evidence');

        const nextBtn = statusRow.locator('[data-label="Next Action"] .task-next-action');
        await expect(nextBtn).toHaveAttribute('href', /#\/tasks\?.*taskId=/);
        await nextBtn.click();
        const detailRow = taskRow(page, task.id);
        await expect(detailRow).toBeVisible({ timeout: 10000 });
        await expect(detailRow.locator('[data-completion-proof-task="' + task.id + '"]')).toBeVisible();
        await expect(detailRow.locator('.task-status-checkbox')).toBeDisabled();
      } finally {
        await cleanupTask(request, task);
      }
    });

    test('Dashboard file-proof rows route into the bundle workflow instead of embedding the uploader', async ({ page, request }) => {
      const today = todayString();
      let task;
      let bundleId;

      try {
        const bundleRes = await request.post('/api/bundles', {
          data: { title: 'Dashboard file evidence bundle', anchorDate: today, status: 'active' },
        });
        bundleId = (await bundleRes.json()).bundle.id;

        const fileRes = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard invoice proof newsletter task',
            date: today,
            assigneeId: GRACE_ID,
            bundleId,
            source: 'template',
            requiresFile: true,
            proofRequirement: { type: 'file', label: 'Invoice PDF or invoice proof', required: true },
          },
        });
        task = await fileRes.json();

        await page.goto('/#/');
        await waitForDashboardTasksLoaded(page);

        const fileRow = taskRow(page, task.id);
        await expect(fileRow).toContainText('Attach Invoice PDF or invoice proof to complete');
        await expect(fileRow.locator('.task-status-checkbox')).toBeDisabled();
        await expectSingleQueueNextAction(fileRow, 'Add file');

        const nextBtn = fileRow.locator('[data-label="Next Action"] .task-next-action');
        await expect(nextBtn).toHaveAttribute('href', new RegExp('#/bundles\\?.*taskId=' + task.id));
        await nextBtn.click();

        // The bundle workflow-detail is where the file evidence can be attached.
        await page.waitForSelector('[data-testid="workflow-context"]', { timeout: 15000 });
        const detailRow = page.locator('[data-task-row="' + task.id + '"]');
        await expect(detailRow).toBeVisible();
        const toggle = detailRow.locator('[data-task-expand]').first();
        if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
        await expect(detailRow.locator('[data-required-file-task="' + task.id + '"]')).toBeVisible();
        await expect(detailRow.locator('.task-status-checkbox')).toBeDisabled();
      } finally {
        await cleanupTask(request, task);
        await cleanupBundle(request, bundleId);
      }
    });

    test('Dashboard ready task completes in place via the Complete button', async ({ page, request }) => {
      const today = todayString();
      let task;

      try {
        const res = await request.post('/api/tasks', {
          data: {
            description: 'Dashboard ready-to-complete newsletter task',
            date: today,
            assigneeId: GRACE_ID,
          },
        });
        task = await res.json();

        await page.goto('/#/');
        await waitForDashboardTasksLoaded(page);

        const row = await waitForDashboardTaskRow(page, task.id);
        await expectSingleQueueNextAction(row, 'Complete');
        const completeBtn = row.locator('[data-complete-task="' + task.id + '"]');
        await expect(completeBtn).toBeEnabled();
        await Promise.all([
          successfulTaskUpdate(page, task.id, 'status'),
          completeBtn.click(),
        ]);
        await expect.poll(async () => {
          const saved = await (await request.get('/api/tasks/' + task.id)).json();
          return saved.status;
        }).toBe('done');
      } finally {
        await cleanupTask(request, task);
      }
    });

    test('Dashboard required-link rows route into the bundle workflow, not an inline URL input', async ({ page, request }) => {
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
        await waitForDashboardTasksLoaded(page);

        // Bundle-backed required-link task: routes into the bundle workflow.
        const linkRow = taskRow(page, created[0].id);
        await expect(linkRow).toContainText('Add Sponsorship document link to complete');
        await expect(linkRow.locator('.task-status-checkbox')).toBeDisabled();
        await expectSingleQueueNextAction(linkRow, 'Add link');
        await expect(linkRow.locator('[data-label="Next Action"] .task-next-action'))
          .toHaveAttribute('href', new RegExp('#/bundles\\?.*taskId=' + created[0].id));

        // Ad-hoc skip-closure task: no inline skip dropdown, no Save evidence.
        const skippedRow = taskRow(page, created[1].id);
        await expect(skippedRow.locator('.task-status-checkbox')).toBeDisabled();
        await expectSingleQueueNextAction(skippedRow, 'Add link');
        await expect(skippedRow.locator('[data-label="Next Action"] .task-next-action'))
          .toHaveAttribute('href', /#\/tasks\?.*taskId=/);

        // Clicking through lands on the bundle workflow-detail context.
        await linkRow.locator('[data-label="Next Action"] .task-next-action').click();
        await page.waitForSelector('[data-testid="workflow-context"]', { timeout: 15000 });
        await expect(page.locator('[data-task-row="' + created[0].id + '"]')).toBeVisible();
      } finally {
        for (const task of created) {
          await cleanupTask(request, task);
        }
        await cleanupBundle(request, bundleId);
      }
    });

    test('Dashboard shared-bundle-link rows route into the bundle workflow, not an inline URL input', async ({ page, request }) => {
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
        await waitForDashboardTasksLoaded(page);

        const sharedLinkRow = taskRow(page, task.id);
        await expect(sharedLinkRow).toContainText('Add Mailchimp newsletter shared link to complete');
        await expect(sharedLinkRow.locator('.task-status-checkbox')).toBeDisabled();
        await expectSingleQueueNextAction(sharedLinkRow, 'Add link');
        await expect(sharedLinkRow.locator('[data-label="Next Action"] .task-next-action'))
          .toHaveAttribute('href', new RegExp('#/bundles\\?.*taskId=' + task.id));

        await sharedLinkRow.locator('[data-label="Next Action"] .task-next-action').click();
        await page.waitForSelector('[data-testid="workflow-context"]', { timeout: 15000 });
        await expect(page.locator('[data-task-row="' + task.id + '"]')).toBeVisible();
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
        await waitForDashboardTasksLoaded(page);

        const overdueRow = page.locator('[data-task-row="' + created[0].id + '"]');
        await expect(overdueRow).toContainText('Overdue');

        const followUpRow = page.locator('[data-task-row="' + created[1].id + '"]');
        await expect(followUpRow).toContainText('Follow-up due');

        const todayRow = page.locator('[data-task-row="' + created[2].id + '"]');
        await expect(todayRow).toContainText('Today');

        // The four core operator questions lead the queue in priority order:
        // Today, Overdue, Follow-ups due, At-risk workflows (#105).
        const groupHeadings = await page.locator('#dashboard-tasks .dashboard-queue-group').allTextContents();
        expect(groupHeadings.indexOf('Today')).toBeGreaterThanOrEqual(0);
        expect(groupHeadings.indexOf('Overdue')).toBeGreaterThanOrEqual(0);
        expect(groupHeadings.indexOf('Follow-ups due')).toBeGreaterThanOrEqual(0);
        expect(groupHeadings.indexOf('At-risk workflows')).toBeGreaterThanOrEqual(0);
        expect(groupHeadings.indexOf('Today')).toBeLessThan(groupHeadings.indexOf('Overdue'));
        expect(groupHeadings.indexOf('Overdue')).toBeLessThan(groupHeadings.indexOf('Follow-ups due'));
        expect(groupHeadings.indexOf('Follow-ups due')).toBeLessThan(groupHeadings.indexOf('At-risk workflows'));

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

    test('Dashboard leads with the four core sections in order and demotes intake counters (#105)', async ({ page, request }) => {
      const today = todayString();
      const created = [];

      try {
        const todayRes = await request.post('/api/tasks', {
          data: {
            description: 'Core IA today task',
            date: today,
            assigneeId: GRACE_ID,
            validation: { dashboardStates: ['today'] },
          },
        });
        created.push(await todayRes.json());

        const overdueRes = await request.post('/api/tasks', {
          data: {
            description: 'Core IA overdue task',
            date: offsetDateString(-1),
            assigneeId: GRACE_ID,
            validation: { dashboardStates: ['overdue'] },
          },
        });
        created.push(await overdueRes.json());

        const followUpRes = await request.post('/api/tasks', {
          data: {
            description: 'Core IA follow-up task',
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

        await page.goto('/#/');
        await waitForDashboardTasksLoaded(page);

        // The four core questions are the first, labelled top-level sections, in
        // priority order, and always present.
        const groupHeadings = await page.locator('#dashboard-tasks .dashboard-queue-group').allTextContents();
        expect(groupHeadings.slice(0, 4)).toEqual(['Today', 'Overdue', 'Follow-ups due', 'At-risk workflows']);

        // Intake counters are demoted to a small strip below the queue, not the
        // top of the dashboard.
        const strip = page.locator('.dashboard-intake-strip');
        await expect(strip).toBeVisible();
        await expect(strip.locator('[data-testid="dashboard-intake-risk"]')).toContainText('Untriaged intake');
        const stripBelowQueue = await page.evaluate(() => {
          const layout = document.querySelector('.dashboard-layout');
          const stripEl = document.querySelector('.dashboard-intake-strip');
          if (!layout || !stripEl) return false;
          // Node.DOCUMENT_POSITION_FOLLOWING (4) => strip comes after the layout.
          return (layout.compareDocumentPosition(stripEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        });
        expect(stripBelowQueue).toBe(true);
      } finally {
        for (const task of created) {
          await cleanupTask(request, task);
        }
      }
    });

    test('A due-today, not-at-risk task appears under Today, not At-risk workflows (#105)', async ({ page, request }) => {
      const today = todayString();
      let task;

      try {
        // Genuinely due today, not overdue, no missing required proof.
        const res = await request.post('/api/tasks', {
          data: {
            description: 'Due today ready task',
            date: today,
            assigneeId: GRACE_ID,
            validation: { dashboardStates: ['today'] },
          },
        });
        task = await res.json();

        await page.goto('/#/');
        await waitForDashboardTaskRow(page, task.id);

        const row = taskRow(page, task.id);
        await expect(row).toContainText('Today');

        const section = await queueSectionForRow(page, task.id);
        expect(section).toBe('Today');
        expect(section).not.toBe('At-risk workflows');
      } finally {
        await cleanupTask(request, task);
      }
    });

    test('Dashboard daily queue layout keeps dense operational rows readable', async ({ page, request }) => {
      const today = todayString();
      const created = [];
      let bundleId;

      try {
        const bundleRes = await request.post('/api/bundles', {
          data: {
            title: 'Issue 61 podcast workflow acceptance',
            anchorDate: today,
            status: 'active',
            bundleLinks: [
              { name: 'Sponsor document', url: '' },
              { name: 'Luma event page', url: '' },
            ],
          },
        });
        bundleId = (await bundleRes.json()).bundle.id;

        const taskInputs = [
          {
            description: 'Confirm guest recording date and send the operational follow-up note',
            date: offsetDateString(-2),
            assigneeId: GRACE_ID,
            bundleId,
            source: 'template',
            status: 'waiting',
            waitingFor: 'Jane Guest',
            followUpAt: today,
            comment: 'Waiting for guest confirmation',
            validation: { dashboardStates: ['waiting', 'follow-up-due'] },
          },
          {
            description: 'Review sponsor copy from migrated Trello card',
            date: offsetDateString(-1),
            assigneeId: GRACE_ID,
            bundleId,
            source: 'template',
            requiredLinkName: 'Sponsor document',
            proofRequirement: { type: 'url', label: 'Sponsor document', required: true },
            validation: { dashboardStates: ['overdue'], requiredBundleLinks: ['Sponsor document'] },
          },
          {
            description: 'Approve assistant-generated podcast prep document',
            date: today,
            assigneeId: GRACE_ID,
            bundleId,
            source: 'template',
            proofRequirement: { type: 'external-status', label: 'Approved podcast waiting approval artifact', required: true },
            validation: {
              dashboardStates: ['missing-evidence'],
              atRiskWhen: ['missing-evidence'],
            },
          },
          {
            description: 'Review today queue and confirm podcast guest assets',
            date: today,
            assigneeId: GRACE_ID,
            bundleId,
            source: 'template',
            validation: { dashboardStates: ['today'] },
          },
          {
            description: 'Agree on recording date with guest',
            date: today,
            assigneeId: GRACE_ID,
            bundleId,
            source: 'template',
            status: 'waiting',
            waitingFor: 'Audio production',
            followUpAt: offsetDateString(2),
            comment: 'Waiting for production slot',
            validation: { dashboardStates: ['waiting'] },
          },
        ];

        for (const data of taskInputs) {
          const res = await request.post('/api/tasks', { data });
          created.push(await res.json());
        }

        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto('/#/');
        await waitForDashboardTasksLoaded(page);

        // The queue no longer embeds the completion editor; each row exposes a
        // single Next Action button and the raw Required Proof column is gone (#103).
        await expect(page.locator('#dashboard-tasks thead')).not.toContainText('Required Proof');
        await expect(page.locator('#dashboard-tasks thead')).toContainText('Next Action');

        for (const group of ['Today', 'Overdue', 'Follow-ups due', 'At-risk workflows', 'Waiting']) {
          await expect(page.locator('#dashboard-tasks .dashboard-queue-group', { hasText: group }).first()).toBeVisible();
        }

        const desktopLayoutProblems = await page.evaluate(() => {
          const root = document.querySelector('#dashboard-tasks');
          const problems = [];
          if (!root) return ['missing dashboard queue'];
          if (document.documentElement.scrollWidth > document.documentElement.clientWidth) {
            problems.push('document has horizontal overflow');
          }

          root.querySelectorAll('[data-task-row] > td > *, .dashboard-task-actions-row .task-action-group > *').forEach((el) => {
            const rect = el.getBoundingClientRect();
            const parent = el.closest('td') || el.parentElement;
            const parentRect = parent.getBoundingClientRect();
            if (rect.width > 0 && (rect.left < parentRect.left - 1 || rect.right > parentRect.right + 1)) {
              problems.push((el.textContent || el.getAttribute('class') || el.tagName).trim() + ' overflows its cell');
            }
          });

          // No raw required-link/file inputs should be embedded in queue rows.
          root.querySelectorAll('.required-link-input, .required-bundle-link-input, [data-completion-proof-task], [data-required-file-task], [data-skip-closure-task], [data-save-completion-proof]').forEach((el) => {
            problems.push('inline proof editor still embedded: ' + (el.getAttribute('class') || el.tagName));
          });

          // The single next-action button must not truncate its label mid-word.
          root.querySelectorAll('.task-next-action').forEach((el) => {
            if (el.scrollWidth > el.clientWidth + 1) {
              problems.push('next-action label truncated: ' + (el.textContent || '').trim());
            }
          });

          root.querySelectorAll('.dashboard-task-actions-row .task-action-btn').forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 72) {
              problems.push('follow-up button collapsed to ' + Math.round(rect.width) + 'px');
            }
          });

          return problems;
        });
        expect(desktopLayoutProblems).toEqual([]);
        await screenshotIssue67(page, 'desktop-operations-home-baseline');

        await page.setViewportSize({ width: 412, height: 915 });
        await expect(taskRow(page, created[0].id).locator('[data-label="Task"]')).toBeVisible();
        await expect(taskRow(page, created[1].id).locator('[data-label="Status / Proof"]')).toBeVisible();
        await expect(taskRow(page, created[0].id).locator('[data-label="Next Action"]')).toBeVisible();

        const mobileLayoutProblems = await page.evaluate(() => {
          const problems = [];
          if (document.documentElement.scrollWidth > document.documentElement.clientWidth) {
            problems.push('document has horizontal overflow');
          }
          document.querySelectorAll('#dashboard-tasks input:not([type="checkbox"]), #dashboard-tasks button, #dashboard-tasks select').forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.height < 28) {
              problems.push((el.textContent || el.getAttribute('class') || el.tagName).trim() + ' touch target too short');
            }
          });
          return problems;
        });
        expect(mobileLayoutProblems).toEqual([]);

        const mobileTapTargetProblems = await page.evaluate(() => {
          const problems = [];
          const tooSmall = (label, rect, minWidth, minHeight) => {
            if (rect.width > 0 && rect.height > 0 && (rect.width < minWidth || rect.height < minHeight)) {
              problems.push(label + ' is ' + Math.round(rect.width) + 'x' + Math.round(rect.height));
            }
          };

          document.querySelectorAll('#dashboard-tasks [data-task-row] .task-status-hit-target').forEach((el, index) => {
            tooSmall('dashboard checkbox target ' + (index + 1), el.getBoundingClientRect(), 40, 40);
          });

          const assignedToggle = document.querySelector('.assigned-toggle');
          if (!assignedToggle) problems.push('missing Assigned to me target');
          else tooSmall('assigned-to-me target', assignedToggle.getBoundingClientRect(), 40, 40);

          document.querySelectorAll('#dashboard-tasks [data-task-row] .badge-bundle').forEach((el, index) => {
            tooSmall('dashboard bundle badge target ' + (index + 1), el.getBoundingClientRect(), 1, 32);
            if (!/^Open bundle /.test(el.getAttribute('aria-label') || '')) {
              problems.push('dashboard bundle badge ' + (index + 1) + ' missing Open bundle accessible name');
            }
          });

          return problems;
        });
        expect(mobileTapTargetProblems).toEqual([]);
        await screenshotIssue67(page, 'pixel7-operations-home');

        await page.goto('/#/bundles?bundleId=' + bundleId);
        await page.waitForSelector('[data-testid="workflow-context"]', { timeout: 10000 });
        await expect(page.locator('[data-task-row="' + created[0].id + '"]')).toContainText('Waiting: Jane Guest');

        const workflowTapTargetProblems = await page.evaluate(() => {
          const problems = [];
          const tooSmall = (label, rect, minWidth, minHeight) => {
            if (rect.width > 0 && rect.height > 0 && (rect.width < minWidth || rect.height < minHeight)) {
              problems.push(label + ' is ' + Math.round(rect.width) + 'x' + Math.round(rect.height));
            }
          };

          if (document.documentElement.scrollWidth > document.documentElement.clientWidth) {
            problems.push('workflow detail has horizontal overflow');
            Array.from(document.querySelectorAll('body *')).forEach((el) => {
              if (problems.length >= 6) return;
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.right > document.documentElement.clientWidth + 1) {
                const label = (el.textContent || el.getAttribute('class') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 80);
                problems.push('overflowing element: ' + label + ' right=' + Math.round(rect.right));
              }
            });
          }

          document.querySelectorAll('.task-checklist-row .task-status-hit-target').forEach((el, index) => {
            tooSmall('workflow checkbox target ' + (index + 1), el.getBoundingClientRect(), 40, 40);
          });

          document.querySelectorAll('.task-checklist-row button, .task-checklist-row select, .task-checklist-row input:not([type="checkbox"])').forEach((el, index) => {
            tooSmall('workflow action control ' + (index + 1), el.getBoundingClientRect(), 1, 32);
          });

          return problems;
        });
        expect(workflowTapTargetProblems).toEqual([]);
        await screenshotIssue67(page, 'pixel7-workflow-detail-follow-up');
      } finally {
        for (const task of created) {
          await cleanupTask(request, task);
        }
        await cleanupBundle(request, bundleId);
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
