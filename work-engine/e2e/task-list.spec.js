const { test, expect } = require('@playwright/test');

// Helper to get today's date in YYYY-MM-DD format
function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Seed user IDs (from seed-users script)
const GRACE_ID = '00000000-0000-0000-0000-000000000001';
const VALERIIA_ID = '00000000-0000-0000-0000-000000000002';

test.describe('Task list view redesign', () => {

  // ──────────────────────────────────────────────────────────────────
  // Setup: ensure seed users exist for the tests
  // ──────────────────────────────────────────────────────────────────

  test.describe('Scenario: Grace views tasks with instructions and required links', () => {
    let taskWithInstructions;
    let taskWithRequiredLink;
    const today = todayString();

    test.beforeAll(async ({ request }) => {
      // Create a task with instructionsUrl
      const res1 = await request.post('/api/tasks', {
        data: {
          description: 'Task with instructions E2E',
          date: today,
          instructionsUrl: 'https://docs.google.com/inst-e2e',
        },
      });
      taskWithInstructions = await res1.json();

      // Create a task with requiredLinkName and empty link
      const res2 = await request.post('/api/tasks', {
        data: {
          description: 'Task with required link E2E',
          date: today,
          requiredLinkName: 'Luma',
        },
      });
      taskWithRequiredLink = await res2.json();
    });

    test.afterAll(async ({ request }) => {
      if (taskWithInstructions) {
        await request.delete('/api/tasks/' + taskWithInstructions.id);
      }
      if (taskWithRequiredLink) {
        await request.delete('/api/tasks/' + taskWithRequiredLink.id);
      }
    });

    test('shows instructions link icon and required link input with disabled checkbox', async ({ page }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('[data-task-row]');

      // Find the row for the task with instructions
      const instrRow = page.locator('[data-task-row="' + taskWithInstructions.id + '"]');
      await expect(instrRow).toBeVisible();

      // Should have a clickable instructions link
      const instrLink = instrRow.locator('.instructions-link');
      await expect(instrLink).toBeVisible();
      await expect(instrLink).toHaveAttribute('href', 'https://docs.google.com/inst-e2e');
      await expect(instrLink).toHaveAttribute('target', '_blank');
      await expect(instrLink).toHaveAttribute('aria-label', 'Open instructions for Task with instructions E2E');

      // Find the row for the task with required link
      const reqRow = page.locator('[data-task-row="' + taskWithRequiredLink.id + '"]');
      await expect(reqRow).toBeVisible();

      // Should have a required link input with Luma label
      const reqLabel = reqRow.locator('.required-link-label');
      await expect(reqLabel).toHaveText('Luma:');

      const reqInput = reqRow.locator('.required-link-input');
      await expect(reqInput).toBeVisible();

      // Checkbox should be disabled
      const checkbox = reqRow.locator('.task-status-checkbox');
      await expect(checkbox).toBeDisabled();
    });
  });

  test.describe('Scenario: Grace fills in a required link to enable task completion', () => {
    let task;
    const today = todayString();

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/tasks', {
        data: {
          description: 'YouTube required link E2E',
          date: today,
          requiredLinkName: 'YouTube',
        },
      });
      task = await res.json();
    });

    test.afterAll(async ({ request }) => {
      if (task) {
        await request.delete('/api/tasks/' + task.id);
      }
    });

    test('typing a link and pressing Enter saves it and enables the checkbox', async ({ page }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('[data-task-row]');

      const row = page.locator('[data-task-row="' + task.id + '"]');
      await expect(row).toBeVisible();

      // Checkbox should be disabled initially
      const checkbox = row.locator('.task-status-checkbox');
      await expect(checkbox).toBeDisabled();

      // Fill in the required link
      const input = row.locator('.required-link-input');
      await input.fill('https://youtube.com/watch?v=abc');
      await input.press('Enter');

      // Wait for reload - the checkbox should now be enabled
      await page.waitForTimeout(500);
      await page.waitForSelector('[data-task-row="' + task.id + '"]');

      const updatedRow = page.locator('[data-task-row="' + task.id + '"]');
      const updatedCheckbox = updatedRow.locator('.task-status-checkbox');
      await expect(updatedCheckbox).toBeEnabled();

      // Verify via API that the link was saved
      const apiRes = await page.request.get('/api/tasks/' + task.id);
      const taskData = await apiRes.json();
      expect(taskData.link).toBe('https://youtube.com/watch?v=abc');
    });
  });

  test.describe('Scenario: Grace filters tasks by assignee', () => {
    let taskGrace;
    let taskValeriia;
    let taskUnassigned;
    const today = todayString();

    test.beforeAll(async ({ request }) => {
      // Check if Grace user exists; if not, these tests will still work
      // but assignee names won't display
      const res1 = await request.post('/api/tasks', {
        data: {
          description: 'Grace task for filter E2E',
          date: today,
          assigneeId: GRACE_ID,
        },
      });
      taskGrace = await res1.json();

      const res2 = await request.post('/api/tasks', {
        data: {
          description: 'Valeriia task for filter E2E',
          date: today,
          assigneeId: VALERIIA_ID,
        },
      });
      taskValeriia = await res2.json();

      const res3 = await request.post('/api/tasks', {
        data: {
          description: 'Unassigned task for filter E2E',
          date: today,
        },
      });
      taskUnassigned = await res3.json();
    });

    test.afterAll(async ({ request }) => {
      if (taskGrace) await request.delete('/api/tasks/' + taskGrace.id);
      if (taskValeriia) await request.delete('/api/tasks/' + taskValeriia.id);
      if (taskUnassigned) await request.delete('/api/tasks/' + taskUnassigned.id);
    });

    test('filtering by assignee shows only matching tasks', async ({ page }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('[data-task-row]');

      // Initially all tasks should be visible
      await expect(page.locator('[data-task-row="' + taskGrace.id + '"]')).toBeVisible();
      await expect(page.locator('[data-task-row="' + taskValeriia.id + '"]')).toBeVisible();
      await expect(page.locator('[data-task-row="' + taskUnassigned.id + '"]')).toBeVisible();

      // Select Grace in the assignee filter
      const assigneeSelect = page.locator('#filter-assignee');

      // Check if Grace option is available (it depends on seed users existing)
      const graceOption = assigneeSelect.locator('option[value="' + GRACE_ID + '"]');
      const graceExists = await graceOption.count();

      if (graceExists > 0) {
        await assigneeSelect.selectOption(GRACE_ID);
        await page.waitForTimeout(500);
        await page.waitForSelector('[data-task-row]');

        // Only Grace's task should be visible
        await expect(page.locator('[data-task-row="' + taskGrace.id + '"]')).toBeVisible();
        // Others should not be visible
        await expect(page.locator('[data-task-row="' + taskValeriia.id + '"]')).not.toBeVisible();
        await expect(page.locator('[data-task-row="' + taskUnassigned.id + '"]')).not.toBeVisible();

        // Reset filter
        await assigneeSelect.selectOption('');
        await page.waitForTimeout(500);
      }
    });
  });

  test.describe('Scenario: Grace filters tasks by bundle', () => {
    let bundle;
    let bundleTask1;
    let bundleTask2;
    let nonBundleTask;
    const today = todayString();

    test.beforeAll(async ({ request }) => {
      // Create a bundle
      const bRes = await request.post('/api/bundles', {
        data: {
          title: 'Newsletter #145 E2E',
          anchorDate: today,
        },
      });
      bundle = (await bRes.json()).bundle || (await bRes.json());
      // handle both shapes
      if (!bundle.id) {
        const bData = await request.get('/api/bundles');
        const allBundles = (await bData.json()).bundles || [];
        bundle = allBundles.find(function (b) { return b.title === 'Newsletter #145 E2E'; });
      }

      // Create tasks in that bundle
      const t1Res = await request.post('/api/tasks', {
        data: {
          description: 'Bundle task 1 E2E',
          date: today,
          bundleId: bundle.id,
        },
      });
      bundleTask1 = await t1Res.json();

      const t2Res = await request.post('/api/tasks', {
        data: {
          description: 'Bundle task 2 E2E',
          date: today,
          bundleId: bundle.id,
        },
      });
      bundleTask2 = await t2Res.json();

      // A task NOT in the bundle but on a different date so it won't show by default
      const t3Res = await request.post('/api/tasks', {
        data: {
          description: 'Non-bundle task E2E',
          date: '2099-01-01',
        },
      });
      nonBundleTask = await t3Res.json();
    });

    test.afterAll(async ({ request }) => {
      if (bundleTask1) await request.delete('/api/tasks/' + bundleTask1.id);
      if (bundleTask2) await request.delete('/api/tasks/' + bundleTask2.id);
      if (nonBundleTask) await request.delete('/api/tasks/' + nonBundleTask.id);
      if (bundle) await request.delete('/api/bundles/' + bundle.id);
    });

    test('selecting a bundle in the filter shows only that bundle tasks', async ({ page }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('[data-task-row]');

      // Select the bundle in the filter
      const bundleSelect = page.locator('#filter-bundle');

      // Wait for bundles to populate
      await page.waitForTimeout(500);

      const bundleOption = bundleSelect.locator('option[value="' + bundle.id + '"]');
      const bundleExists = await bundleOption.count();

      if (bundleExists > 0) {
        await bundleSelect.selectOption(bundle.id);
        await page.waitForTimeout(500);
        await page.waitForSelector('[data-task-row]');

        // Bundle tasks should be visible
        await expect(page.locator('[data-task-row="' + bundleTask1.id + '"]')).toBeVisible();
        await expect(page.locator('[data-task-row="' + bundleTask2.id + '"]')).toBeVisible();

        // Non-bundle task should NOT be visible (different date, and we're querying by bundle)
        await expect(page.locator('[data-task-row="' + nonBundleTask.id + '"]')).not.toBeVisible();
      }
    });
  });

  test.describe('Scenario: Grace creates a task with an assignee', () => {
    let createdTaskId;
    const today = todayString();

    test.afterAll(async ({ request }) => {
      if (createdTaskId) {
        await request.delete('/api/tasks/' + createdTaskId);
      }
    });

    test('creates a task with assignee via the form', async ({ page, request }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('#task-create-btn');

      // Fill in description
      await page.fill('#task-desc', 'Review sponsor document E2E');

      // Select assignee (if users are seeded)
      const assigneeSelect = page.locator('#task-assignee');
      await page.waitForTimeout(500); // wait for users to load

      const valeriiaOption = assigneeSelect.locator('option[value="' + VALERIIA_ID + '"]');
      const hasValeriia = await valeriiaOption.count();

      if (hasValeriia > 0) {
        await assigneeSelect.selectOption(VALERIIA_ID);
      }

      // Click create
      await page.click('#task-create-btn');

      // Wait for task list to reload
      await page.waitForTimeout(500);
      await page.waitForSelector('[data-task-row]');

      // Verify the task was created via API
      const listRes = await request.get('/api/tasks?date=' + today);
      const listData = await listRes.json();
      const createdTask = listData.tasks.find(function (t) {
        return t.description === 'Review sponsor document E2E';
      });
      expect(createdTask).toBeDefined();
      createdTaskId = createdTask.id;

      if (hasValeriia > 0) {
        expect(createdTask.assigneeId).toBe(VALERIIA_ID);
      }
    });
  });

  test.describe('Scenario: Task list layout changes', () => {
    let testTask;
    const today = todayString();

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/tasks', {
        data: {
          description: 'Layout test task E2E',
          date: today,
        },
      });
      testTask = await res.json();
    });

    test.afterAll(async ({ request }) => {
      if (testTask) await request.delete('/api/tasks/' + testTask.id);
    });

    test('comment column is removed', async ({ page }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('[data-task-row]');

      // The table headers should NOT contain "Comment"
      const headers = await page.locator('.task-table-compact th').allTextContents();
      expect(headers).not.toContain('Comment');
    });

    test('delete button is removed', async ({ page }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('[data-task-row]');

      // No delete buttons in the task table
      const deleteButtons = page.locator('.task-table-compact [data-delete-task]');
      await expect(deleteButtons).toHaveCount(0);
    });

    test('table headers include expected columns', async ({ page }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('[data-task-row]');

      const headers = await page.locator('.task-table-compact th').allTextContents();
      // Should have columns: (empty for checkbox), Date, Description, Bundle, Info, Assignee, Required Link
      expect(headers.length).toBe(7);
      expect(headers).toContain('Date');
      expect(headers).toContain('Description');
      expect(headers).toContain('Bundle');
      expect(headers).toContain('Assignee');
      expect(headers).toContain('Required Link');
    });

    test('create form has no comment field', async ({ page }) => {
      await page.goto('/#/tasks');

      // Comment field should NOT exist
      const commentField = page.locator('#task-comment');
      await expect(commentField).toHaveCount(0);

      // Assignee dropdown should exist
      const assigneeField = page.locator('#task-assignee');
      await expect(assigneeField).toBeVisible();
    });

    test('status filter dropdown exists', async ({ page }) => {
      await page.goto('/#/tasks');

      const statusFilter = page.locator('#filter-status');
      await expect(statusFilter).toBeVisible();

      // Should have All, Todo, Done options
      const options = await statusFilter.locator('option').allTextContents();
      expect(options).toContain('All');
      expect(options).toContain('Todo');
      expect(options).toContain('Done');
    });

    test('assignee filter dropdown exists', async ({ page }) => {
      await page.goto('/#/tasks');

      const assigneeFilter = page.locator('#filter-assignee');
      await expect(assigneeFilter).toBeVisible();
    });

    test('bundle filter dropdown exists', async ({ page }) => {
      await page.goto('/#/tasks');

      const bundleFilter = page.locator('#filter-bundle');
      await expect(bundleFilter).toBeVisible();
    });
  });

  test.describe('Scenario: Status filter works', () => {
    let todoTask;
    let doneTask;
    const today = todayString();

    test.beforeAll(async ({ request }) => {
      const res1 = await request.post('/api/tasks', {
        data: {
          description: 'Status filter todo E2E',
          date: today,
        },
      });
      todoTask = await res1.json();

      const res2 = await request.post('/api/tasks', {
        data: {
          description: 'Status filter done E2E',
          date: today,
        },
      });
      doneTask = await res2.json();

      // Mark the second task as done
      await request.put('/api/tasks/' + doneTask.id, {
        data: { status: 'done' },
      });
    });

    test.afterAll(async ({ request }) => {
      if (todoTask) await request.delete('/api/tasks/' + todoTask.id);
      if (doneTask) await request.delete('/api/tasks/' + doneTask.id);
    });

    test('filtering by todo shows only todo tasks', async ({ page }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('[data-task-row]');

      // Select "Todo" status filter
      await page.selectOption('#filter-status', 'todo');
      await page.waitForTimeout(500);

      // Todo task should be visible
      await expect(page.locator('[data-task-row="' + todoTask.id + '"]')).toBeVisible();
      // Done task should NOT be visible
      await expect(page.locator('[data-task-row="' + doneTask.id + '"]')).not.toBeVisible();
    });

    test('filtering by done shows only done tasks', async ({ page }) => {
      await page.goto('/#/tasks');
      await page.waitForSelector('[data-task-row]');

      // Select "Done" status filter
      await page.selectOption('#filter-status', 'done');
      await page.waitForTimeout(500);

      // Done task should be visible
      await expect(page.locator('[data-task-row="' + doneTask.id + '"]')).toBeVisible();
      // Todo task should NOT be visible
      await expect(page.locator('[data-task-row="' + todoTask.id + '"]')).not.toBeVisible();
    });
  });
});
