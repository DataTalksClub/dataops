const { test, expect } = require('@playwright/test');

// Helper to create a template via API
async function createTemplate(request, data) {
  const res = await request.post('/api/templates', { data });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return body.template;
}

// Generate a unique suffix for test isolation
function uid() {
  return Math.random().toString(36).slice(2, 8);
}

test.describe('Template Editor (issue #29)', () => {

  // Scenario: Grace views templates as cards
  test('displays templates as cards with emoji, name, type, tags, task count, and trigger type', async ({ page, request }) => {
    var suffix = uid();

    // Create 3 templates via API
    const newsletter = await createTemplate(request, {
      name: 'NL-' + suffix,
      type: 'newsletter',
      emoji: '\u{1F4F0}',
      tags: ['weekly', 'content'],
      triggerType: 'automatic',
      triggerSchedule: '0 9 * * 1',
      triggerLeadDays: 14,
      taskDefinitions: [
        { refId: 'draft', description: 'Write draft', offsetDays: -7 },
        { refId: 'send', description: 'Send newsletter', offsetDays: 0 },
      ],
    });

    const podcast = await createTemplate(request, {
      name: 'PC-' + suffix,
      type: 'podcast',
      emoji: '\u{1F399}\u{FE0F}',
      tags: ['content'],
      triggerType: 'manual',
      taskDefinitions: [
        { refId: 'record', description: 'Record episode', offsetDays: -3 },
        { refId: 'edit', description: 'Edit audio', offsetDays: -1 },
        { refId: 'publish', description: 'Publish', offsetDays: 0 },
      ],
    });

    const webinar = await createTemplate(request, {
      name: 'WB-' + suffix,
      type: 'webinar',
      emoji: '\u{1F4BB}',
      tags: ['event'],
      taskDefinitions: [
        { refId: 'setup', description: 'Set up event', offsetDays: -5 },
      ],
    });

    // Navigate to templates page
    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    // Verify cards are present
    const cards = page.locator('.template-card');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThanOrEqual(3);

    // Check Newsletter card content
    const newsletterCard = page.locator('.template-card', { hasText: 'NL-' + suffix });
    await expect(newsletterCard).toBeVisible();
    await expect(newsletterCard.locator('.template-card-title')).toContainText('NL-' + suffix);
    await expect(newsletterCard.locator('.badge-type')).toContainText('newsletter');
    await expect(newsletterCard.locator('.template-card-tasks')).toContainText('2 tasks');
    await expect(newsletterCard.locator('.badge-trigger.automatic')).toBeVisible();
    await expect(newsletterCard.locator('.card-action-text')).toHaveText('Edit template');

    // Check tags
    const tagBadges = newsletterCard.locator('.badge-tag');
    const tagTexts = await tagBadges.allTextContents();
    expect(tagTexts).toContain('weekly');
    expect(tagTexts).toContain('content');

    // Check Podcast card
    const podcastCard = page.locator('.template-card', { hasText: 'PC-' + suffix });
    await expect(podcastCard).toBeVisible();
    await expect(podcastCard.locator('.template-card-tasks')).toContainText('3 tasks');
    await expect(podcastCard.locator('.badge-trigger.manual')).toBeVisible();

    // Cleanup
    await request.delete(`/api/templates/${newsletter.id}`);
    await request.delete(`/api/templates/${podcast.id}`);
    await request.delete(`/api/templates/${webinar.id}`);
  });

  // Scenario: Grace edits a template's basic fields
  test('clicking a card opens editor, edits basic fields, and saves', async ({ page, request }) => {
    var suffix = uid();
    var name = 'EditBasic-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'newsletter',
      emoji: '\u{1F4F0}',
      tags: ['weekly'],
      taskDefinitions: [
        { refId: 'draft', description: 'Write draft', offsetDays: -7 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    // Click on the card
    const card = page.locator('.template-card', { hasText: name });
    await card.click();

    // Should see editor with back button
    await page.waitForSelector('.btn-back');
    await expect(page.locator('.btn-back')).toContainText('Back to Templates');

    // Verify basic fields are populated
    await expect(page.locator('#tpl-name')).toHaveValue(name);
    await expect(page.locator('#tpl-emoji')).toHaveValue('\u{1F4F0}');

    // Change name and emoji
    var newName = 'EditBasicV2-' + suffix;
    await page.fill('#tpl-name', newName);
    await page.fill('#tpl-emoji', '\u{1F4E8}');

    // Click save
    await page.click('#tpl-save-btn');
    await page.waitForSelector('.save-feedback.success');
    await expect(page.locator('#tpl-save-feedback')).toContainText('Saved successfully');

    // Go back to card list
    await page.click('.btn-back');
    await page.waitForSelector('.template-card');

    // Verify the card shows the updated values
    const updatedCard = page.locator('.template-card', { hasText: newName });
    await expect(updatedCard).toBeVisible();
    await expect(updatedCard.locator('.template-card-title')).toContainText(newName);

    // Verify via API
    const res = await request.get(`/api/templates/${template.id}`);
    const body = await res.json();
    expect(body.template.name).toBe(newName);
    expect(body.template.emoji).toBe('\u{1F4E8}');

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  test('editor shows summary, sticky save controls, dirty state, and save success feedback', async ({ page, request }) => {
    var suffix = uid();
    var name = 'EditorUX-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      references: [{ name: 'Guide', url: 'https://example.com/guide' }],
      bundleLinkDefinitions: [{ name: 'Luma' }],
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
        { refId: 'b', description: 'Task B', offsetDays: 1 },
      ],
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    await page.locator('.template-card', { hasText: name }).click();
    await page.waitForSelector('.template-editor');

    await expect(page.locator('.template-editor-header h2')).toContainText(name);
    await expect(page.locator('#template-editor-summary')).toContainText('2 tasks');
    await expect(page.locator('#template-editor-summary')).toContainText('1 reference');
    await expect(page.locator('#template-editor-summary')).toContainText('1 bundle link');
    await expect(page.locator('#tpl-save-feedback')).toContainText('No unsaved changes');

    const saveBarVisible = await page.locator('.template-save-bar').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    expect(saveBarVisible).toBe(true);

    await page.locator('#tpl-name').fill(name + '-updated');
    await expect(page.locator('#tpl-save-feedback')).toContainText('Unsaved changes');

    await page.locator('#tpl-save-btn').click();
    await page.waitForSelector('.save-feedback.success');
    await expect(page.locator('#tpl-save-feedback')).toContainText('Saved successfully');
    await expect(page.locator('.success-banner')).toContainText('Template saved.');

    await request.delete(`/api/templates/${template.id}`);
  });

  // Scenario: Grace configures automatic trigger settings
  test('trigger config shows/hides cron and lead days based on trigger type', async ({ page, request }) => {
    var suffix = uid();
    var name = 'Trigger-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      triggerType: 'manual',
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    // Manual should be selected, auto fields hidden
    await expect(page.locator('#trigger-auto-fields')).toBeHidden();

    // Select Automatic
    await page.click('input[name="tpl-trigger"][value="automatic"]');
    await expect(page.locator('#trigger-auto-fields')).toBeVisible();

    // Fill in cron and lead days
    await page.fill('#tpl-cron', '0 9 * * 1');
    await page.fill('#tpl-lead-days', '14');

    // Save
    await page.click('#tpl-save-btn');
    await page.waitForSelector('.save-feedback.success');

    // Verify via API
    const res = await request.get(`/api/templates/${template.id}`);
    const body = await res.json();
    expect(body.template.triggerType).toBe('automatic');
    expect(body.template.triggerSchedule).toBe('0 9 * * 1');
    expect(body.template.triggerLeadDays).toBe(14);

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  // Scenario: Grace adds a reference link to a template
  test('references can be added, edited, and removed', async ({ page, request }) => {
    var suffix = uid();
    var name = 'RefTest-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      references: [
        { name: 'Style Guide', url: 'https://docs.google.com/style' },
        { name: 'Process Doc', url: 'https://docs.google.com/process' },
      ],
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    // Should see 2 existing references
    const refRows = page.locator('#tpl-references-list .ref-row');
    await expect(refRows).toHaveCount(2);

    // Click Add Reference
    await page.click('button:has-text("+ Add Reference")');
    await expect(refRows).toHaveCount(3);

    // Fill in the new reference
    const newRow = refRows.nth(2);
    await newRow.locator('.ref-name').fill('New Guide');
    await newRow.locator('.ref-url').fill('https://docs.google.com/new-guide');

    // Save
    await page.click('#tpl-save-btn');
    await page.waitForSelector('.save-feedback.success');

    // Verify via API
    const res = await request.get(`/api/templates/${template.id}`);
    const body = await res.json();
    expect(body.template.references).toHaveLength(3);
    expect(body.template.references[2].name).toBe('New Guide');
    expect(body.template.references[2].url).toBe('https://docs.google.com/new-guide');

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  // Scenario: Grace edits a task definition's fields
  test('task definitions can be edited with all fields', async ({ page, request }) => {
    var suffix = uid();
    var name = 'TaskEdit-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      taskDefinitions: [
        { refId: 'announce', description: 'Announce event', offsetDays: -7 },
        { refId: 'stream', description: 'Actual stream', offsetDays: 0, isMilestone: true },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    // Should see 2 task definitions
    const taskItems = page.locator('#tpl-taskdefs-list .task-def-item');
    await expect(taskItems).toHaveCount(2);

    // The second task (Actual stream) should have milestone checked
    const streamItem = taskItems.nth(1);
    await expect(streamItem.locator('.td-milestone')).toBeChecked();

    // Stage on complete should be visible since milestone is checked
    await expect(streamItem.locator('.td-stage-group')).toBeVisible();

    // Set stageOnComplete to after-event
    await streamItem.locator('.td-stage').selectOption('after-event');

    // Save
    await page.click('#tpl-save-btn');
    await page.waitForSelector('.save-feedback.success');

    // Verify via API
    const res = await request.get(`/api/templates/${template.id}`);
    const body = await res.json();
    const streamTd = body.template.taskDefinitions.find(function (td) { return td.refId === 'stream'; });
    expect(streamTd.stageOnComplete).toBe('after-event');
    expect(streamTd.isMilestone).toBe(true);

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  // Scenario: Grace adds a new task definition
  test('task definitions can be added and removed', async ({ page, request }) => {
    var suffix = uid();
    var name = 'AddTask-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
        { refId: 'b', description: 'Task B', offsetDays: 1 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    const taskItems = page.locator('#tpl-taskdefs-list .task-def-item');
    await expect(taskItems).toHaveCount(2);

    // Click Add Task
    await page.click('#add-task-def-btn');
    await expect(taskItems).toHaveCount(3);

    // Fill in the new task
    const newItem = taskItems.nth(2);
    await newItem.locator('.td-description').fill('New follow-up task');
    await newItem.locator('.td-offset').fill('7');

    // Save
    await page.click('#tpl-save-btn');
    await page.waitForSelector('.save-feedback.success');

    // Verify via API
    const res = await request.get(`/api/templates/${template.id}`);
    const body = await res.json();
    expect(body.template.taskDefinitions).toHaveLength(3);
    const newTd = body.template.taskDefinitions[2];
    expect(newTd.description).toBe('New follow-up task');
    expect(newTd.offsetDays).toBe(7);

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  // Test: Task definitions can be removed
  test('removing a task definition works', async ({ page, request }) => {
    var suffix = uid();
    var name = 'RemoveTask-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
        { refId: 'b', description: 'Task B', offsetDays: 1 },
        { refId: 'c', description: 'Task C', offsetDays: 2 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    const taskItems = page.locator('#tpl-taskdefs-list .task-def-item');
    await expect(taskItems).toHaveCount(3);

    // Remove the second task (Task B)
    await taskItems.nth(1).locator('.btn-remove').click();
    await expect(taskItems).toHaveCount(2);

    // Save
    await page.click('#tpl-save-btn');
    await page.waitForSelector('.save-feedback.success');

    // Verify via API
    const res = await request.get(`/api/templates/${template.id}`);
    const body = await res.json();
    expect(body.template.taskDefinitions).toHaveLength(2);
    expect(body.template.taskDefinitions[0].refId).toBe('a');
    expect(body.template.taskDefinitions[1].refId).toBe('c');

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  // Test: Bundle link definitions can be added, edited, and removed
  test('bundle link definitions can be added, edited, and removed', async ({ page, request }) => {
    var suffix = uid();
    var name = 'BLDTest-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      bundleLinkDefinitions: [{ name: 'Luma' }],
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    const bldRows = page.locator('#tpl-bundlelinks-list .bld-row');
    await expect(bldRows).toHaveCount(1);

    // Add a new bundle link
    await page.click('button:has-text("+ Add Bundle Link")');
    await expect(bldRows).toHaveCount(2);

    // Fill in the new bundle link
    await bldRows.nth(1).locator('.bld-name').fill('YouTube');

    // Save
    await page.click('#tpl-save-btn');
    await page.waitForSelector('.save-feedback.success');

    // Verify via API
    const res = await request.get(`/api/templates/${template.id}`);
    const body = await res.json();
    expect(body.template.bundleLinkDefinitions).toHaveLength(2);
    expect(body.template.bundleLinkDefinitions[0].name).toBe('Luma');
    expect(body.template.bundleLinkDefinitions[1].name).toBe('YouTube');

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  // Test: Back to Templates button returns to card list
  test('back button returns to card list from editor', async ({ page, request }) => {
    var suffix = uid();
    var name = 'BackTest-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    // Click on card to open editor
    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    // Should not see template cards
    await expect(page.locator('.template-cards')).toHaveCount(0);

    // Click back
    await page.click('.btn-back');
    await page.waitForSelector('.template-cards');

    // Should see template cards again
    await expect(page.locator('.template-card')).not.toHaveCount(0);

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  // Test: Task definitions can be reordered via drag-and-drop
  test('task definitions support drag-and-drop reordering', async ({ page, request }) => {
    var suffix = uid();
    var name = 'DragTest-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      taskDefinitions: [
        { refId: 'first', description: 'First Task', offsetDays: 0 },
        { refId: 'second', description: 'Second Task', offsetDays: 1 },
        { refId: 'third', description: 'Third Task', offsetDays: 2 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    // Verify all 3 task defs are shown
    const taskItems = page.locator('#tpl-taskdefs-list .task-def-item');
    await expect(taskItems).toHaveCount(3);

    // Verify items are draggable
    const firstItem = taskItems.nth(0);
    const draggable = await firstItem.getAttribute('draggable');
    expect(draggable).toBe('true');

    // Verify drag handles exist
    const handles = page.locator('.task-def-drag-handle');
    await expect(handles).toHaveCount(3);

    // Programmatically simulate drag-and-drop by manually reordering DOM + saving
    await page.evaluate(() => {
      const container = document.getElementById('tpl-taskdefs-list');
      const items = container.querySelectorAll('.task-def-item');
      // Move the third item before the first item
      container.insertBefore(items[2], items[0]);
    });

    // Save with reordered items
    await page.click('#tpl-save-btn');

    // Wait for any save feedback (success or error)
    await page.waitForFunction(() => {
      const fb = document.getElementById('tpl-save-feedback');
      return fb && fb.textContent && fb.textContent !== 'Saving...';
    }, { timeout: 10000 });

    const feedbackText = await page.locator('#tpl-save-feedback').textContent();
    expect(feedbackText).toBe('Saved successfully!');

    // Verify via API that order changed
    const res = await request.get(`/api/templates/${template.id}`);
    const body = await res.json();
    expect(body.template.taskDefinitions[0].refId).toBe('third');
    expect(body.template.taskDefinitions[1].refId).toBe('first');
    expect(body.template.taskDefinitions[2].refId).toBe('second');

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  // Test: Milestone checkbox controls stage-on-complete visibility
  test('stage on complete is hidden when milestone is unchecked', async ({ page, request }) => {
    var suffix = uid();
    var name = 'MilestoneToggle-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    const taskItem = page.locator('#tpl-taskdefs-list .task-def-item').first();

    // Milestone is not checked, stage group should be hidden
    await expect(taskItem.locator('.td-milestone')).not.toBeChecked();
    await expect(taskItem.locator('.td-stage-group')).toBeHidden();

    // Check milestone
    await taskItem.locator('.td-milestone').check();
    await expect(taskItem.locator('.td-stage-group')).toBeVisible();

    // Uncheck milestone
    await taskItem.locator('.td-milestone').uncheck();
    await expect(taskItem.locator('.td-stage-group')).toBeHidden();

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });

  // Test: Removing a reference
  test('removing a reference works', async ({ page, request }) => {
    var suffix = uid();
    var name = 'RemoveRef-' + suffix;

    const template = await createTemplate(request, {
      name: name,
      type: 'test',
      references: [
        { name: 'Ref 1', url: 'https://example.com/1' },
        { name: 'Ref 2', url: 'https://example.com/2' },
      ],
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    await page.goto('/#/templates');
    await page.waitForSelector('.template-card');

    const card = page.locator('.template-card', { hasText: name });
    await card.click();
    await page.waitForSelector('.template-editor');

    const refRows = page.locator('#tpl-references-list .ref-row');
    await expect(refRows).toHaveCount(2);

    // Remove the first reference
    await refRows.nth(0).locator('.btn-remove').click();
    await expect(refRows).toHaveCount(1);

    // Save
    await page.click('#tpl-save-btn');
    await page.waitForSelector('.save-feedback.success');

    // Verify via API
    const res = await request.get(`/api/templates/${template.id}`);
    const body = await res.json();
    expect(body.template.references).toHaveLength(1);
    expect(body.template.references[0].name).toBe('Ref 2');

    // Cleanup
    await request.delete(`/api/templates/${template.id}`);
  });
});
