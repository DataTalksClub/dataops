const { test, expect } = require('@playwright/test');

// Helper: UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Helper: create a template via API and return the template object.
 */
async function createTemplate(request, data) {
  const res = await request.post('/api/templates', { data });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return body.template;
}

/**
 * Helper: create a bundle from a template via API and return { bundle, tasks }.
 */
async function createBundleFromTemplate(request, data) {
  const res = await request.post('/api/bundles', { data });
  expect(res.status()).toBe(201);
  return await res.json();
}

// ──────────────────────────────────────────────────────────────────
// Template instantiation with new fields (issue #20)
// ──────────────────────────────────────────────────────────────────

test.describe('Template instantiation - bundle inherits template metadata', () => {

  test('bundle inherits emoji, tags, references, and bundleLinks from template when not provided by caller', async ({ request }) => {
    // Given: A template exists with emoji, tags, references, and bundleLinkDefinitions
    const template = await createTemplate(request, {
      name: 'E2E Full Template',
      type: 'event',
      emoji: '📰',
      tags: ['newsletter', 'weekly'],
      references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
      bundleLinkDefinitions: [{ name: 'Luma' }, { name: 'YouTube' }],
      taskDefinitions: [
        { refId: 'prep', description: 'Prepare', offsetDays: -7 },
        { refId: 'event', description: 'Run event', offsetDays: 0 },
      ],
    });

    // When: A user creates a bundle without specifying emoji/tags/references/bundleLinks
    const { bundle, tasks } = await createBundleFromTemplate(request, {
      title: 'E2E Inherited Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Then: The bundle has the template's emoji, tags, and references
    expect(bundle.emoji).toBe('📰');
    expect(bundle.tags).toEqual(['newsletter', 'weekly']);
    expect(bundle.references).toEqual([{ name: 'Style guide', url: 'https://docs.google.com/style' }]);

    // And: bundleLinks are created from bundleLinkDefinitions with empty URL strings
    expect(bundle.bundleLinks).toEqual([
      { name: 'Luma', url: '' },
      { name: 'YouTube', url: '' },
    ]);

    // And: tasks were created
    expect(tasks).toHaveLength(2);
  });

  test('bundle inherits fields and they persist via GET', async ({ request }) => {
    const template = await createTemplate(request, {
      name: 'E2E Persist Template',
      type: 'event',
      emoji: '🎙️',
      tags: ['podcast'],
      references: [{ name: 'Docs', url: 'https://example.com/docs' }],
      bundleLinkDefinitions: [{ name: 'Luma' }],
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    const { bundle } = await createBundleFromTemplate(request, {
      title: 'E2E Persist Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Verify via GET
    const res = await request.get(`/api/bundles/${bundle.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.bundle.emoji).toBe('🎙️');
    expect(body.bundle.tags).toEqual(['podcast']);
    expect(body.bundle.references).toEqual([{ name: 'Docs', url: 'https://example.com/docs' }]);
    expect(body.bundle.bundleLinks).toEqual([{ name: 'Luma', url: '' }]);
  });
});

test.describe('Template instantiation - caller overrides template metadata', () => {

  test('caller-provided emoji and tags override template values', async ({ request }) => {
    // Given: A template exists with emoji and tags
    const template = await createTemplate(request, {
      name: 'E2E Override Template',
      type: 'event',
      emoji: '📰',
      tags: ['newsletter'],
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    // When: A user creates a bundle with their own emoji and tags
    const { bundle } = await createBundleFromTemplate(request, {
      title: 'E2E Override Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
      emoji: '🎉',
      tags: ['custom'],
    });

    // Then: The bundle uses the caller's values
    expect(bundle.emoji).toBe('🎉');
    expect(bundle.tags).toEqual(['custom']);
  });

  test('caller-provided references and bundleLinks override template values', async ({ request }) => {
    const template = await createTemplate(request, {
      name: 'E2E Override Links Template',
      type: 'event',
      references: [{ name: 'Template ref', url: 'https://template.com' }],
      bundleLinkDefinitions: [{ name: 'Luma' }],
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    const { bundle } = await createBundleFromTemplate(request, {
      title: 'E2E Override Links Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
      references: [{ name: 'Custom ref', url: 'https://custom.com' }],
      bundleLinks: [{ name: 'Custom link', url: 'https://custom-link.com' }],
    });

    expect(bundle.references).toEqual([{ name: 'Custom ref', url: 'https://custom.com' }]);
    expect(bundle.bundleLinks).toEqual([{ name: 'Custom link', url: 'https://custom-link.com' }]);
  });
});

test.describe('Template instantiation - task instructionsUrl', () => {

  test('tasks inherit instructionsUrl from template task definitions (not in comment)', async ({ request }) => {
    // Given: A template has a task definition with instructionsUrl
    const template = await createTemplate(request, {
      name: 'E2E Instructions Template',
      type: 'test',
      taskDefinitions: [
        {
          refId: 'inst',
          description: 'Create campaign',
          offsetDays: 0,
          instructionsUrl: 'https://docs.google.com/instructions',
        },
      ],
    });

    // When: A bundle is created from that template
    const { tasks } = await createBundleFromTemplate(request, {
      title: 'E2E Instructions Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Then: The created task has instructionsUrl set to the URL
    expect(tasks[0].instructionsUrl).toBe('https://docs.google.com/instructions');
    // And: comment is not set to the URL
    expect(tasks[0].comment).toBeUndefined();

    // Verify via GET
    const taskRes = await request.get(`/api/tasks/${tasks[0].id}`);
    expect(taskRes.status()).toBe(200);
    const taskBody = await taskRes.json();
    expect(taskBody.instructionsUrl).toBe('https://docs.google.com/instructions');
  });
});

test.describe('Template instantiation - assigneeId with fallback', () => {

  test('tasks inherit assigneeId from task definition, falling back to defaultAssigneeId', async ({ request }) => {
    // Given: A template has defaultAssigneeId and two task definitions
    const template = await createTemplate(request, {
      name: 'E2E Assignee Template',
      type: 'test',
      defaultAssigneeId: 'user-grace',
      taskDefinitions: [
        { refId: 'specific', description: 'Has specific assignee', offsetDays: 0, assigneeId: 'user-valeriia' },
        { refId: 'default', description: 'Uses default', offsetDays: 1 },
      ],
    });

    // When: A bundle is created from that template
    const { tasks } = await createBundleFromTemplate(request, {
      title: 'E2E Assignee Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Then: The first task has specific assigneeId
    const specificTask = tasks.find(t => t.templateTaskRef === 'specific');
    expect(specificTask.assigneeId).toBe('user-valeriia');

    // And: The second task falls back to defaultAssigneeId
    const defaultTask = tasks.find(t => t.templateTaskRef === 'default');
    expect(defaultTask.assigneeId).toBe('user-grace');
  });
});

test.describe('Template instantiation - requiredLinkName', () => {

  test('tasks inherit requiredLinkName from template task definitions', async ({ request }) => {
    // Given: A template has a task definition with requiredLinkName
    const template = await createTemplate(request, {
      name: 'E2E RequiredLink Template',
      type: 'test',
      taskDefinitions: [
        { refId: 'luma-task', description: 'Create event on Luma', offsetDays: 0, requiredLinkName: 'Luma' },
      ],
    });

    // When: A bundle is created from that template
    const { tasks } = await createBundleFromTemplate(request, {
      title: 'E2E RequiredLink Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Then: The created task has requiredLinkName
    expect(tasks[0].requiredLinkName).toBe('Luma');

    // And: Attempting to mark the task as done without setting link returns 400
    const failRes = await request.put(`/api/tasks/${tasks[0].id}`, {
      data: { status: 'done' },
    });
    expect(failRes.status()).toBe(400);
    const failBody = await failRes.json();
    expect(failBody.error).toContain('Luma');

    // When: The link is filled, the task can be marked done
    const successRes = await request.put(`/api/tasks/${tasks[0].id}`, {
      data: { status: 'done', link: 'https://luma.com/event' },
    });
    expect(successRes.status()).toBe(200);
    const successBody = await successRes.json();
    expect(successBody.status).toBe('done');
  });
});

test.describe('Template instantiation - tags inheritance', () => {

  test('tasks inherit tags from the template', async ({ request }) => {
    // Given: A template has tags
    const template = await createTemplate(request, {
      name: 'E2E Tags Template',
      type: 'test',
      tags: ['podcast', 'content'],
      taskDefinitions: [
        { refId: 'task1', description: 'Task 1', offsetDays: 0 },
        { refId: 'task2', description: 'Task 2', offsetDays: 1 },
      ],
    });

    // When: A bundle is created from that template
    const { tasks } = await createBundleFromTemplate(request, {
      title: 'E2E Tags Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Then: All created tasks have the template's tags
    for (const task of tasks) {
      expect(task.tags).toEqual(['podcast', 'content']);
    }
  });
});

test.describe('Template instantiation - milestone stage transition', () => {

  test('milestone task completion triggers stage transition on the bundle', async ({ request }) => {
    // Given: A template has a milestone task with stageOnComplete
    const template = await createTemplate(request, {
      name: 'E2E Stage Template',
      type: 'test',
      taskDefinitions: [
        { refId: 'prep', description: 'Prepare materials', offsetDays: -7 },
        {
          refId: 'stream',
          description: 'Actual stream',
          offsetDays: 0,
          isMilestone: true,
          stageOnComplete: 'after-event',
        },
        { refId: 'followup', description: 'Follow up', offsetDays: 3 },
      ],
    });

    // And: A bundle has been created from that template
    const { bundle, tasks } = await createBundleFromTemplate(request, {
      title: 'E2E Stage Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Verify bundle starts at "preparation"
    expect(bundle.stage).toBe('preparation');

    // When: The milestone task is marked as done
    const milestoneTask = tasks.find(t => t.templateTaskRef === 'stream');
    expect(milestoneTask).toBeDefined();

    const updateRes = await request.put(`/api/tasks/${milestoneTask.id}`, {
      data: { status: 'done' },
    });
    expect(updateRes.status()).toBe(200);

    // Then: The bundle's stage is automatically updated to "after-event"
    const bundleRes = await request.get(`/api/bundles/${bundle.id}`);
    expect(bundleRes.status()).toBe(200);
    const bundleBody = await bundleRes.json();
    expect(bundleBody.bundle.stage).toBe('after-event');
  });

  test('non-milestone task completion does not trigger stage transition', async ({ request }) => {
    // Given: A bundle created from a template with milestone and regular tasks
    const template = await createTemplate(request, {
      name: 'E2E No Stage Change Template',
      type: 'test',
      taskDefinitions: [
        { refId: 'regular', description: 'Regular task', offsetDays: -7 },
        {
          refId: 'milestone',
          description: 'Milestone',
          offsetDays: 0,
          isMilestone: true,
          stageOnComplete: 'after-event',
        },
      ],
    });

    const { bundle, tasks } = await createBundleFromTemplate(request, {
      title: 'E2E No Stage Change Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    expect(bundle.stage).toBe('preparation');

    // When: A regular task is marked as done
    const regularTask = tasks.find(t => t.templateTaskRef === 'regular');
    expect(regularTask).toBeDefined();

    const updateRes = await request.put(`/api/tasks/${regularTask.id}`, {
      data: { status: 'done' },
    });
    expect(updateRes.status()).toBe(200);

    // Then: The bundle's stage remains unchanged
    const bundleRes = await request.get(`/api/bundles/${bundle.id}`);
    expect(bundleRes.status()).toBe(200);
    const bundleBody = await bundleRes.json();
    expect(bundleBody.bundle.stage).toBe('preparation');
  });

  test('stage transition does not occur when task is not being marked as done', async ({ request }) => {
    const template = await createTemplate(request, {
      name: 'E2E No Done Template',
      type: 'test',
      taskDefinitions: [
        {
          refId: 'milestone',
          description: 'Milestone',
          offsetDays: 0,
          isMilestone: true,
          stageOnComplete: 'after-event',
        },
      ],
    });

    const { bundle, tasks } = await createBundleFromTemplate(request, {
      title: 'E2E No Done Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    expect(bundle.stage).toBe('preparation');

    // When: The milestone task's description is updated (not status)
    const milestoneTask = tasks.find(t => t.templateTaskRef === 'milestone');
    const updateRes = await request.put(`/api/tasks/${milestoneTask.id}`, {
      data: { description: 'Updated description' },
    });
    expect(updateRes.status()).toBe(200);

    // Then: The bundle's stage remains unchanged
    const bundleRes = await request.get(`/api/bundles/${bundle.id}`);
    expect(bundleRes.status()).toBe(200);
    const bundleBody = await bundleRes.json();
    expect(bundleBody.bundle.stage).toBe('preparation');
  });
});

test.describe('Template instantiation - date calculation', () => {

  test('task dates are correctly calculated from anchor date and offset days', async ({ request }) => {
    // Given: A template has tasks with offsetDays -14, -7, 0, +3, +7
    const template = await createTemplate(request, {
      name: 'E2E Date Calc Template',
      type: 'test',
      taskDefinitions: [
        { refId: 'd-14', description: 'Two weeks before', offsetDays: -14 },
        { refId: 'd-7', description: 'One week before', offsetDays: -7 },
        { refId: 'd0', description: 'Anchor day', offsetDays: 0, isMilestone: true },
        { refId: 'd3', description: 'Three days after', offsetDays: 3 },
        { refId: 'd7', description: 'One week after', offsetDays: 7 },
      ],
    });

    // When: A bundle is created with anchorDate "2026-06-15"
    const { tasks } = await createBundleFromTemplate(request, {
      title: 'E2E Date Calc Bundle',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Then: The task dates are correctly calculated
    const dates = tasks.map(t => t.date).sort();
    expect(dates).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
      '2026-06-18',
      '2026-06-22',
    ]);
  });

  test('milestone tasks with offsetDays=0 are fixed to the anchor date', async ({ request }) => {
    const template = await createTemplate(request, {
      name: 'E2E Milestone Date Template',
      type: 'test',
      taskDefinitions: [
        { refId: 'milestone', description: 'Event day', offsetDays: 0, isMilestone: true },
      ],
    });

    const { tasks } = await createBundleFromTemplate(request, {
      title: 'E2E Milestone Date Bundle',
      anchorDate: '2026-07-20',
      templateId: template.id,
    });

    expect(tasks[0].date).toBe('2026-07-20');
  });
});

test.describe('Existing bundle and template tests still pass', () => {

  test('creating a bundle without a template still works normally', async ({ request }) => {
    const res = await request.post('/api/bundles', {
      data: { title: 'No template bundle', anchorDate: '2026-08-01' },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.bundle.title).toBe('No template bundle');
    expect(body.bundle.stage).toBe('preparation');
    expect(body.bundle.status).toBe('active');
    expect(body.tasks).toBeUndefined();
  });

  test('creating a bundle with a basic template still generates tasks', async ({ request }) => {
    const template = await createTemplate(request, {
      name: 'E2E Basic Template',
      type: 'test',
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
        { refId: 'b', description: 'Task B', offsetDays: 5 },
      ],
    });

    const { bundle, tasks } = await createBundleFromTemplate(request, {
      title: 'E2E Basic Bundle',
      anchorDate: '2026-05-01',
      templateId: template.id,
    });

    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task.source).toBe('template');
      expect(task.bundleId).toBe(bundle.id);
    }
  });
});
