const { test, expect } = require('@playwright/test');

// Helper to archive and delete a bundle
async function archiveAndDelete(request, bundleId) {
  await request.put(`/api/bundles/${bundleId}/archive`);
  await request.delete(`/api/bundles/${bundleId}`);
}

// Generate unique suffix for test isolation
function uid() {
  return Math.random().toString(36).slice(2, 8);
}

test.describe('Bundle detail view (issue #27)', () => {

  // ── Scenario: Grace views a bundle with references and bundle links ──
  test.describe('Scenario: Grace views a bundle with references and bundle links', () => {
    let bundleId;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: {
          title: 'Weekly email ' + suffix,
          anchorDate: '2026-04-15',
          emoji: '\u{1F4F0}',
          stage: 'preparation',
          references: [
            { name: 'Process docs', url: 'https://docs.google.com/proc' },
          ],
          bundleLinks: [
            { name: 'Luma', url: '' },
            { name: 'YouTube', url: 'https://youtube.com/x' },
          ],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      bundleId = body.bundle.id;
    });

    test.afterAll(async ({ request }) => {
      if (bundleId) {
        await archiveAndDelete(request, bundleId);
      }
    });

    test('shows emoji + title, anchor date, stage badge, progress badge, references, and bundle links', async ({ page }) => {
      // Navigate to bundles page
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      // Click on the bundle card to go to detail
      const card = page.locator('.bundle-card', { hasText: 'Weekly email ' + suffix });
      await card.locator('.bundle-card-title').click();

      // Wait for bundle detail to load
      await page.waitForSelector('[data-testid="stage-badge"]');

      // Header: emoji + title
      const header = page.locator('.bundle-detail-header h2');
      await expect(header).toContainText('Weekly email ' + suffix);

      // Anchor date badge
      const anchorBadge = page.locator('.badge-anchor-date');
      await expect(anchorBadge).toHaveText('2026-04-15');

      // Stage badge
      const stageBadge = page.locator('[data-testid="stage-badge"]');
      await expect(stageBadge).toHaveText('preparation');
      await expect(stageBadge).toHaveClass(/preparation/);

      // Progress badge
      const progressBadge = page.locator('[data-testid="progress-badge"]');
      await expect(progressBadge).toContainText('done');

      // References section: "Process docs" as clickable read-only link
      const refsSection = page.locator('.references-section');
      await expect(refsSection).toBeVisible();
      const refLink = refsSection.locator('.reference-link');
      await expect(refLink).toHaveText('Process docs');
      await expect(refLink).toHaveAttribute('href', 'https://docs.google.com/proc');
      await expect(refLink).toHaveAttribute('target', '_blank');

      // Bundle links section: "Luma" with empty input, "YouTube" with pre-filled URL
      const blSection = page.locator('.bundle-links-editable');
      await expect(blSection).toBeVisible();

      const linkRows = blSection.locator('.bundle-link-row');
      expect(await linkRows.count()).toBe(2);

      // Luma row: empty input
      const lumaRow = linkRows.nth(0);
      await expect(lumaRow.locator('.bundle-link-label')).toHaveText('Luma');
      await expect(lumaRow.locator('.bundle-link-url-input')).toHaveValue('');

      // YouTube row: pre-filled
      const ytRow = linkRows.nth(1);
      await expect(ytRow.locator('.bundle-link-label')).toHaveText('YouTube');
      await expect(ytRow.locator('.bundle-link-url-input')).toHaveValue('https://youtube.com/x');
    });
  });

  // ── Scenario: Grace fills in a required link on a task ──
  test.describe('Scenario: Grace fills in a required link on a task', () => {
    let bundleId;
    let taskId;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      // Create bundle with Luma bundle link
      const bundleRes = await request.post('/api/bundles', {
        data: {
          title: 'Event ' + suffix,
          anchorDate: '2026-05-01',
          bundleLinks: [{ name: 'Luma', url: '' }],
        },
      });
      expect(bundleRes.status()).toBe(201);
      const bundleBody = await bundleRes.json();
      bundleId = bundleBody.bundle.id;

      // Create task with requiredLinkName
      const taskRes = await request.post('/api/tasks', {
        data: {
          description: 'Create event on Luma ' + suffix,
          date: '2026-05-01',
          bundleId: bundleId,
          requiredLinkName: 'Luma',
          source: 'template',
        },
      });
      expect(taskRes.status()).toBe(201);
      const taskBody = await taskRes.json();
      taskId = taskBody.id;
    });

    test.afterAll(async ({ request }) => {
      if (taskId) {
        await request.delete('/api/tasks/' + taskId);
      }
      if (bundleId) {
        await archiveAndDelete(request, bundleId);
      }
    });

    test('task checkbox is disabled when required link is empty, becomes enabled after filling', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'Event ' + suffix });
      await expect(card).toBeVisible({ timeout: 10000 });
      await card.locator('.bundle-card-title').click();

      await page.waitForSelector('[data-testid="stage-badge"]', { timeout: 10000 });

      // Find the task row
      const taskRow = page.locator('[data-task-row="' + taskId + '"]');
      await expect(taskRow).toBeVisible();

      // Checkbox should be disabled since link is empty
      const checkbox = taskRow.locator('.task-status-checkbox');
      await expect(checkbox).toBeDisabled();

      // Required link label
      const linkLabel = taskRow.locator('.required-link-label');
      await expect(linkLabel).toHaveText('Luma:');

      // Fill in the required link
      const linkInput = taskRow.locator('.required-link-input');
      await linkInput.fill('https://lu.ma/abc');

      // Click save
      const saveBtn = taskRow.locator('[data-save-required-link]');
      await saveBtn.click();

      // Wait for the page to reload
      await page.waitForSelector('[data-testid="stage-badge"]');

      // After reload, the checkbox should now be enabled
      const updatedTaskRow = page.locator('[data-task-row="' + taskId + '"]');
      const updatedCheckbox = updatedTaskRow.locator('.task-status-checkbox');
      await expect(updatedCheckbox).toBeEnabled();

      // The input should have the URL filled
      const updatedInput = updatedTaskRow.locator('.required-link-input');
      await expect(updatedInput).toHaveValue('https://lu.ma/abc');

      // Also verify the bundle link was updated via API
      const bundleRes = await page.request.get('/api/bundles/' + bundleId);
      const bundleData = await bundleRes.json();
      const lumaLink = bundleData.bundle.bundleLinks.find(function (l) { return l.name === 'Luma'; });
      expect(lumaLink.url).toBe('https://lu.ma/abc');
    });
  });

  // ── Scenario: Grace changes the bundle stage ──
  test.describe('Scenario: Grace changes the bundle stage', () => {
    let bundleId;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: {
          title: 'Stage test ' + suffix,
          anchorDate: '2026-06-01',
          stage: 'preparation',
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      bundleId = body.bundle.id;
    });

    test.afterAll(async ({ request }) => {
      if (bundleId) {
        await archiveAndDelete(request, bundleId);
      }
    });

    test('clicking stage transition button changes the stage', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'Stage test ' + suffix });
      await card.locator('.bundle-card-title').click();

      await page.waitForSelector('[data-testid="stage-badge"]');

      // Stage should be "preparation"
      const stageBadge = page.locator('[data-testid="stage-badge"]');
      await expect(stageBadge).toHaveText('preparation');

      // Click "Mark Announced" button
      const stageBtn = page.locator('[data-testid="stage-transition-btn"]');
      await expect(stageBtn).toHaveText('Mark Announced');
      await stageBtn.click();

      // Wait for reload - stage should now be "announced"
      await page.waitForFunction(() => {
        const badge = document.querySelector('[data-testid="stage-badge"]');
        return badge && badge.textContent === 'announced';
      });

      const updatedStageBadge = page.locator('[data-testid="stage-badge"]');
      await expect(updatedStageBadge).toHaveText('announced');

      // The transition button should now say "Mark After-Event"
      const updatedStageBtn = page.locator('[data-testid="stage-transition-btn"]');
      await expect(updatedStageBtn).toHaveText('Mark After-Event');

      // Verify via API
      const res = await page.request.get('/api/bundles/' + bundleId);
      const data = await res.json();
      expect(data.bundle.stage).toBe('announced');
    });
  });

  // ── Scenario: Grace completes a task in the bundle ──
  test.describe('Scenario: Grace completes a task in the bundle', () => {
    let bundleId;
    let taskId;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      const bundleRes = await request.post('/api/bundles', {
        data: {
          title: 'Complete task ' + suffix,
          anchorDate: '2026-07-01',
        },
      });
      expect(bundleRes.status()).toBe(201);
      const bundleBody = await bundleRes.json();
      bundleId = bundleBody.bundle.id;

      const taskRes = await request.post('/api/tasks', {
        data: {
          description: 'Send invites ' + suffix,
          date: '2026-07-01',
          bundleId: bundleId,
          source: 'template',
        },
      });
      expect(taskRes.status()).toBe(201);
      const taskBody = await taskRes.json();
      taskId = taskBody.id;
    });

    test.afterAll(async ({ request }) => {
      if (taskId) {
        await request.delete('/api/tasks/' + taskId);
      }
      if (bundleId) {
        await archiveAndDelete(request, bundleId);
      }
    });

    test('checking a task checkbox marks it done and updates progress badge', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'Complete task ' + suffix });
      await card.locator('.bundle-card-title').click();

      await page.waitForSelector('[data-testid="stage-badge"]');

      // Progress should show 0/1 done
      const progressBadge = page.locator('[data-testid="progress-badge"]');
      await expect(progressBadge).toHaveText('0/1 done');

      // Check the task checkbox
      const checkbox = page.locator('[data-task-checkbox="' + taskId + '"]');
      await expect(checkbox).not.toBeChecked();
      await checkbox.check();

      // Wait for reload
      await page.waitForFunction(() => {
        const badge = document.querySelector('[data-testid="progress-badge"]');
        return badge && badge.textContent === '1/1 done';
      });

      // Progress should now show 1/1 done
      const updatedProgress = page.locator('[data-testid="progress-badge"]');
      await expect(updatedProgress).toHaveText('1/1 done');

      // Task row should have task-done class
      const taskRow = page.locator('[data-task-row="' + taskId + '"]');
      await expect(taskRow).toHaveClass(/task-done/);
    });
  });

  // ── Scenario: Grace adds a custom extra link to the bundle ──
  test.describe('Scenario: Grace adds a custom extra link to the bundle', () => {
    let bundleId;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: {
          title: 'Custom links ' + suffix,
          anchorDate: '2026-08-01',
          bundleLinks: [
            { name: 'Luma', url: '' },
            { name: 'YouTube', url: '' },
          ],
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      bundleId = body.bundle.id;
    });

    test.afterAll(async ({ request }) => {
      if (bundleId) {
        await archiveAndDelete(request, bundleId);
      }
    });

    test('adds a new link via the add link form', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'Custom links ' + suffix });
      await card.locator('.bundle-card-title').click();

      await page.waitForSelector('[data-testid="stage-badge"]');

      // Should see 2 existing link rows
      const blSection = page.locator('.bundle-links-editable');
      let linkRows = blSection.locator('.bundle-link-row');
      expect(await linkRows.count()).toBe(2);

      // Fill in the add link form
      await page.fill('#add-bl-name', 'Spreadsheet');
      await page.fill('#add-bl-url', 'https://docs.google.com/sheet');

      // Click Add
      await page.click('#add-bl-btn');

      // Wait for reload
      await page.waitForFunction(() => {
        const rows = document.querySelectorAll('.bundle-link-row');
        return rows.length === 3;
      });

      // Should now have 3 link rows
      linkRows = page.locator('.bundle-link-row');
      expect(await linkRows.count()).toBe(3);

      // The new row should be "Spreadsheet"
      const newRow = linkRows.nth(2);
      await expect(newRow.locator('.bundle-link-label')).toHaveText('Spreadsheet');
      await expect(newRow.locator('.bundle-link-url-input')).toHaveValue('https://docs.google.com/sheet');

      // Verify via API
      const res = await page.request.get('/api/bundles/' + bundleId);
      const data = await res.json();
      expect(data.bundle.bundleLinks).toHaveLength(3);
      expect(data.bundle.bundleLinks[2].name).toBe('Spreadsheet');
      expect(data.bundle.bundleLinks[2].url).toBe('https://docs.google.com/sheet');
    });
  });

  // ── Scenario: Back button navigates to home dashboard ──
  test.describe('Scenario: Back button navigates to home dashboard (issue #31)', () => {
    let bundleId;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: {
          title: 'Back btn test ' + suffix,
          anchorDate: '2026-04-20',
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      bundleId = body.bundle.id;
    });

    test.afterAll(async ({ request }) => {
      if (bundleId) {
        await archiveAndDelete(request, bundleId);
      }
    });

    test('back button label reads "← Back to Home"', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'Back btn test ' + suffix });
      await card.locator('.bundle-card-title').click();

      await page.waitForSelector('[data-testid="stage-badge"]');

      const backBtn = page.locator('.btn-back');
      await expect(backBtn).toHaveText('\u2190 Back to Home');
    });

    test('clicking back button navigates to #/', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'Back btn test ' + suffix });
      await card.locator('.bundle-card-title').click();

      await page.waitForSelector('[data-testid="stage-badge"]');

      const backBtn = page.locator('.btn-back');
      await backBtn.click();

      // URL hash should now be #/
      await page.waitForFunction(() => location.hash === '#/');
      expect(page.url()).toMatch(/#\/$/);
    });

    test('full round-trip: Home -> bundle card -> bundle detail -> back -> Home', async ({ page }) => {
      // Start at home dashboard
      await page.goto('/#/');
      await page.waitForSelector('.dashboard-bundle-card');

      // Click bundle card from home page
      const card = page.locator('.dashboard-bundle-card', { hasText: 'Back btn test ' + suffix });
      await card.click();

      // Wait for bundle detail
      await page.waitForSelector('[data-testid="stage-badge"]');
      expect(page.url()).toMatch(/#\/bundles/);

      // Click back button
      const backBtn = page.locator('.btn-back');
      await expect(backBtn).toHaveText('\u2190 Back to Home');
      await backBtn.click();

      // Should be back on home dashboard
      await page.waitForFunction(() => location.hash === '#/');
      expect(page.url()).toMatch(/#\/$/);

      // Home dashboard should be visible (bundle cards column)
      await page.waitForSelector('.dashboard-bundle-card');
    });

    test('visiting #/bundles after back-to-home shows list, not stale detail', async ({ page }) => {
      // Navigate to bundle detail
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'Back btn test ' + suffix });
      await card.locator('.bundle-card-title').click();
      await page.waitForSelector('[data-testid="stage-badge"]');

      // Click back to home
      const backBtn = page.locator('.btn-back');
      await backBtn.click();
      await page.waitForFunction(() => location.hash === '#/');

      // Now navigate to #/bundles via hash
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      // Should show bundles list, not a stale bundle detail
      const stageBadge = page.locator('[data-testid="stage-badge"]');
      await expect(stageBadge).not.toBeVisible();
      const bundleCards = page.locator('.bundle-card');
      expect(await bundleCards.count()).toBeGreaterThan(0);
    });
  });

  // ── Tasks table: instructions URL, assignee, no comments ──
  test.describe('Tasks table features', () => {
    let bundleId;
    let taskWithInstr;
    let taskPlain;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      // Create users (seed should already have them, but just in case)
      const bundleRes = await request.post('/api/bundles', {
        data: {
          title: 'TaskTable ' + suffix,
          anchorDate: '2026-09-01',
        },
      });
      expect(bundleRes.status()).toBe(201);
      bundleId = (await bundleRes.json()).bundle.id;

      // Create task with instructionsUrl
      const res1 = await request.post('/api/tasks', {
        data: {
          description: 'InstrTask ' + suffix,
          date: '2026-09-01',
          bundleId: bundleId,
          instructionsUrl: 'https://docs.google.com/instructions',
          source: 'template',
        },
      });
      expect(res1.status()).toBe(201);
      taskWithInstr = await res1.json();

      // Create a plain task
      const res2 = await request.post('/api/tasks', {
        data: {
          description: 'PlainTask ' + suffix,
          date: '2026-09-02',
          bundleId: bundleId,
          source: 'template',
          comment: 'This comment should not be shown',
        },
      });
      expect(res2.status()).toBe(201);
      taskPlain = await res2.json();
    });

    test.afterAll(async ({ request }) => {
      if (taskWithInstr) await request.delete('/api/tasks/' + taskWithInstr.id);
      if (taskPlain) await request.delete('/api/tasks/' + taskPlain.id);
      if (bundleId) await archiveAndDelete(request, bundleId);
    });

    test('shows instructions URL as link icon and does not show comments', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'TaskTable ' + suffix });
      await card.locator('.bundle-card-title').click();

      await page.waitForSelector('[data-testid="stage-badge"]');

      // Task with instructions should have an instructions link
      const instrRow = page.locator('[data-task-row="' + taskWithInstr.id + '"]');
      await expect(instrRow).toBeVisible();
      const instrLink = instrRow.locator('.instructions-link');
      await expect(instrLink).toBeVisible();
      await expect(instrLink).toHaveAttribute('href', 'https://docs.google.com/instructions');
      await expect(instrLink).toHaveAttribute('target', '_blank');
      await expect(instrLink).toHaveAttribute('aria-label', 'Open instructions for ' + taskWithInstr.description);

      // The instructions link should be inside the same task row (inline, not a separate column)
      const instrLinkParent = instrRow.locator('.task-checklist-main-line');
      await expect(instrLinkParent).toBeVisible();

      // Comments column should NOT exist
      const container = page.locator('.bundle-tasks-table');
      await expect(container).toBeVisible();
      const headers = container.locator('th');
      const headerTexts = await headers.allTextContents();
      expect(headerTexts.join(',')).not.toContain('Comment');
    });
  });

  // ── Scenario: Grace scans bundle links to see what needs filling ──
  test.describe('Scenario: Empty bundle link slots are highlighted (issue #35)', () => {
    let bundleId;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: {
          title: 'LinkHighlight ' + suffix,
          anchorDate: '2026-10-01',
          bundleLinks: [
            { name: 'Luma', url: '' },
            { name: 'YouTube', url: 'https://youtube.com/watch?v=abc' },
          ],
        },
      });
      expect(res.status()).toBe(201);
      bundleId = (await res.json()).bundle.id;
    });

    test.afterAll(async ({ request }) => {
      if (bundleId) await archiveAndDelete(request, bundleId);
    });

    test('empty bundle link slot has bundle-link-row--empty class; filled slot does not', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'LinkHighlight ' + suffix });
      await card.locator('.bundle-card-title').click();
      await page.waitForSelector('[data-testid="stage-badge"]');

      const blSection = page.locator('.bundle-links-editable');
      const linkRows = blSection.locator('.bundle-link-row');
      expect(await linkRows.count()).toBe(2);

      // Luma row is empty — should have the empty modifier class
      const lumaRow = linkRows.nth(0);
      await expect(lumaRow.locator('.bundle-link-label')).toHaveText('Luma');
      await expect(lumaRow).toHaveClass(/bundle-link-row--empty/);

      // YouTube row is filled — should NOT have the empty modifier class
      const ytRow = linkRows.nth(1);
      await expect(ytRow.locator('.bundle-link-label')).toHaveText('YouTube');
      await expect(ytRow).not.toHaveClass(/bundle-link-row--empty/);
    });
  });

  // ── Scenario: References render as named links ──
  test.describe('Scenario: References render as named clickable links (issue #35)', () => {
    let bundleId;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: {
          title: 'RefLinks ' + suffix,
          anchorDate: '2026-10-15',
          references: [
            { name: 'Process docs', url: 'https://docs.google.com/proc' },
          ],
        },
      });
      expect(res.status()).toBe(201);
      bundleId = (await res.json()).bundle.id;
    });

    test.afterAll(async ({ request }) => {
      if (bundleId) await archiveAndDelete(request, bundleId);
    });

    test('reference shows name as link text, no raw URL visible', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'RefLinks ' + suffix });
      await card.locator('.bundle-card-title').click();
      await page.waitForSelector('[data-testid="stage-badge"]');

      const refsSection = page.locator('.references-section');
      await expect(refsSection).toBeVisible();

      const refLink = refsSection.locator('.reference-link');
      await expect(refLink).toHaveText('Process docs');
      await expect(refLink).toHaveAttribute('href', 'https://docs.google.com/proc');
      await expect(refLink).toHaveAttribute('target', '_blank');

      // Raw URL should NOT be visible as text content
      const rawText = await refsSection.textContent();
      expect(rawText).not.toContain('https://docs.google.com/proc');
    });
  });

  // ── Scenario: Done tasks are grouped at the bottom ──
  test.describe('Scenario: Done tasks grouped at bottom (issue #35)', () => {
    let bundleId;
    let taskTodo1;
    let taskTodo2;
    let taskDone;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      const bundleRes = await request.post('/api/bundles', {
        data: {
          title: 'Grouping ' + suffix,
          anchorDate: '2026-11-01',
        },
      });
      expect(bundleRes.status()).toBe(201);
      bundleId = (await bundleRes.json()).bundle.id;

      const r1 = await request.post('/api/tasks', {
        data: { description: 'Todo task 1 ' + suffix, date: '2026-11-01', bundleId, source: 'template' },
      });
      expect(r1.status()).toBe(201);
      taskTodo1 = await r1.json();

      const r2 = await request.post('/api/tasks', {
        data: { description: 'Todo task 2 ' + suffix, date: '2026-11-02', bundleId, source: 'template' },
      });
      expect(r2.status()).toBe(201);
      taskTodo2 = await r2.json();

      const r3 = await request.post('/api/tasks', {
        data: { description: 'Done task ' + suffix, date: '2026-11-03', bundleId, source: 'template' },
      });
      expect(r3.status()).toBe(201);
      taskDone = await r3.json();

      // Mark the third task as done
      await request.put('/api/tasks/' + taskDone.id, { data: { status: 'done' } });
    });

    test.afterAll(async ({ request }) => {
      if (taskTodo1) await request.delete('/api/tasks/' + taskTodo1.id);
      if (taskTodo2) await request.delete('/api/tasks/' + taskTodo2.id);
      if (taskDone) await request.delete('/api/tasks/' + taskDone.id);
      if (bundleId) await archiveAndDelete(request, bundleId);
    });

    test('active tasks appear before done tasks, done task has task-done class', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'Grouping ' + suffix });
      await card.locator('.bundle-card-title').click();
      await page.waitForSelector('[data-testid="stage-badge"]');

      const doneRow = page.locator('[data-task-row="' + taskDone.id + '"]');
      await expect(doneRow).toBeVisible();
      await expect(doneRow).toHaveClass(/task-done/);

      const todo1Row = page.locator('[data-task-row="' + taskTodo1.id + '"]');
      await expect(todo1Row).toBeVisible();
      await expect(todo1Row).not.toHaveClass(/task-done/);

      // The done section heading should be visible
      const doneHeading = page.locator('.task-section-heading');
      await expect(doneHeading).toBeVisible();
      await expect(doneHeading).toContainText('Done');

      // The done row should appear AFTER the active rows in DOM order
      const allRows = page.locator('.task-checklist-row');
      const count = await allRows.count();
      expect(count).toBe(3);

      // Find indices of todo and done rows
      let todo1Idx = -1;
      let doneIdx = -1;
      for (let i = 0; i < count; i++) {
        const attr = await allRows.nth(i).getAttribute('data-task-row');
        if (attr === taskTodo1.id) todo1Idx = i;
        if (attr === taskDone.id) doneIdx = i;
      }
      expect(todo1Idx).toBeLessThan(doneIdx);
    });
  });

  // ── Scenario: Milestone tasks have distinct style ──
  test.describe('Scenario: Milestone tasks are visually distinct (issue #35)', () => {
    let bundleId;
    let milestoneTaskId;
    let regularTaskId;
    const suffix = uid();

    test.beforeAll(async ({ request }) => {
      // Create a template with a milestone task
      const tmplRes = await request.post('/api/templates', {
        data: {
          name: 'MilestoneTest ' + suffix,
          type: 'test',
          taskDefinitions: [
            { refId: 'regular', description: 'Regular task ' + suffix, offsetDays: -1 },
            { refId: 'milestone', description: 'Milestone task ' + suffix, offsetDays: 0, isMilestone: true, stageOnComplete: 'after-event' },
          ],
        },
      });
      expect(tmplRes.status()).toBe(201);
      const tmpl = (await tmplRes.json()).template;

      // Create a bundle from that template
      const bundleRes = await request.post('/api/bundles', {
        data: {
          title: 'MilestoneBundle ' + suffix,
          anchorDate: '2026-12-01',
          templateId: tmpl.id,
        },
      });
      expect(bundleRes.status()).toBe(201);
      const bundleData = await bundleRes.json();
      bundleId = bundleData.bundle.id;

      // Get the tasks for this bundle
      const tasksRes = await request.get('/api/bundles/' + bundleId + '/tasks');
      expect(tasksRes.status()).toBe(200);
      const tasksBody = await tasksRes.json();
      const tasks = tasksBody.tasks;

      const milestoneTask = tasks.find(t => t.stageOnComplete === 'after-event');
      const regularTask = tasks.find(t => t.templateTaskRef === 'regular');
      expect(milestoneTask).toBeDefined();
      expect(regularTask).toBeDefined();
      milestoneTaskId = milestoneTask.id;
      regularTaskId = regularTask.id;

      // Clean up template (not needed after instantiation)
      await request.delete('/api/templates/' + tmpl.id);
    });

    test.afterAll(async ({ request }) => {
      if (milestoneTaskId) await request.delete('/api/tasks/' + milestoneTaskId);
      if (regularTaskId) await request.delete('/api/tasks/' + regularTaskId);
      if (bundleId) await archiveAndDelete(request, bundleId);
    });

    test('milestone task row has data-testid="milestone-task-row" and is visually distinct', async ({ page }) => {
      await page.goto('/#/bundles');
      await page.waitForSelector('.bundle-card');

      const card = page.locator('.bundle-card', { hasText: 'MilestoneBundle ' + suffix });
      await card.locator('.bundle-card-title').click();
      await page.waitForSelector('[data-testid="stage-badge"]');

      // Milestone task row has the testid attribute
      const milestoneRow = page.locator('[data-testid="milestone-task-row"]');
      await expect(milestoneRow).toBeVisible();
      await expect(milestoneRow).toHaveAttribute('data-task-row', milestoneTaskId);
      await expect(milestoneRow).toHaveClass(/milestone-task-row/);

      // Regular task row does NOT have the testid attribute
      const regularRow = page.locator('[data-task-row="' + regularTaskId + '"]');
      await expect(regularRow).toBeVisible();
      await expect(regularRow).not.toHaveAttribute('data-testid', 'milestone-task-row');
      await expect(regularRow).not.toHaveClass(/milestone-task-row/);
    });
  });
});
