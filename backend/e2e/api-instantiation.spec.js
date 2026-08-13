const { test, expect } = require('@playwright/test');

// Helper: UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function utcDateString(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

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
 * Helper: create a card from a template via API and return { card, tasks }.
 */
async function createCardFromTemplate(request, data) {
  const res = await request.post('/api/cards', { data });
  expect(res.status()).toBe(201);
  return await res.json();
}

// ──────────────────────────────────────────────────────────────────
// Template instantiation with new fields (issue #20)
// ──────────────────────────────────────────────────────────────────

test.describe('Template instantiation - card inherits template metadata', () => {

  test('card inherits emoji, tags, references, and cardLinks from template when not provided by caller', async ({ request }) => {
    // Given: A template exists with emoji, tags, references, and cardLinkDefinitions
    const template = await createTemplate(request, {
      name: 'E2E Full Template',
      type: 'event',
      emoji: '📰',
      tags: ['newsletter', 'weekly'],
      references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
      cardLinkDefinitions: [{ name: 'Luma' }, { name: 'YouTube' }],
      taskDefinitions: [
        { refId: 'prep', description: 'Prepare', offsetDays: -7 },
        { refId: 'event', description: 'Run event', offsetDays: 0 },
      ],
    });

    // When: A user creates a card without specifying emoji/tags/references/cardLinks
    const { card, tasks } = await createCardFromTemplate(request, {
      title: 'E2E Inherited Card',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Then: The card has the template's emoji, tags, and references
    expect(card.emoji).toBe('📰');
    expect(card.tags).toEqual(['newsletter', 'weekly']);
    expect(card.references).toEqual([{ name: 'Style guide', url: 'https://docs.google.com/style' }]);

    // And: cardLinks are created from cardLinkDefinitions with empty URL strings
    expect(card.cardLinks).toEqual([
      { name: 'Luma', url: '' },
      { name: 'YouTube', url: '' },
    ]);

    // And: tasks were created
    expect(tasks).toHaveLength(2);
  });

  test('card inherits fields and they persist via GET', async ({ request }) => {
    const template = await createTemplate(request, {
      name: 'E2E Persist Template',
      type: 'event',
      emoji: '🎙️',
      tags: ['podcast'],
      references: [{ name: 'Docs', url: 'https://example.com/docs' }],
      cardLinkDefinitions: [{ name: 'Luma' }],
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    const { card } = await createCardFromTemplate(request, {
      title: 'E2E Persist Card',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Verify via GET
    const res = await request.get(`/api/cards/${card.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.card.emoji).toBe('🎙️');
    expect(body.card.tags).toEqual(['podcast']);
    expect(body.card.references).toEqual([{ name: 'Docs', url: 'https://example.com/docs' }]);
    expect(body.card.cardLinks).toEqual([{ name: 'Luma', url: '' }]);
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

    // When: A user creates a card with their own emoji and tags
    const { card } = await createCardFromTemplate(request, {
      title: 'E2E Override Card',
      anchorDate: '2026-06-15',
      templateId: template.id,
      emoji: '🎉',
      tags: ['custom'],
    });

    // Then: The card uses the caller's values
    expect(card.emoji).toBe('🎉');
    expect(card.tags).toEqual(['custom']);
  });

  test('caller-provided references and cardLinks override template values', async ({ request }) => {
    const template = await createTemplate(request, {
      name: 'E2E Override Links Template',
      type: 'event',
      references: [{ name: 'Template ref', url: 'https://template.com' }],
      cardLinkDefinitions: [{ name: 'Luma' }],
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
      ],
    });

    const { card } = await createCardFromTemplate(request, {
      title: 'E2E Override Links Card',
      anchorDate: '2026-06-15',
      templateId: template.id,
      references: [{ name: 'Custom ref', url: 'https://custom.com' }],
      cardLinks: [{ name: 'Custom link', url: 'https://custom-link.com' }],
    });

    expect(card.references).toEqual([{ name: 'Custom ref', url: 'https://custom.com' }]);
    expect(card.cardLinks).toEqual([{ name: 'Custom link', url: 'https://custom-link.com' }]);
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

    // When: A card is created from that template
    const { tasks } = await createCardFromTemplate(request, {
      title: 'E2E Instructions Card',
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

    // When: A card is created from that template
    const { tasks } = await createCardFromTemplate(request, {
      title: 'E2E Assignee Card',
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

    // When: A card is created from that template
    const { tasks } = await createCardFromTemplate(request, {
      title: 'E2E RequiredLink Card',
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

    // When: A card is created from that template
    const { tasks } = await createCardFromTemplate(request, {
      title: 'E2E Tags Card',
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

  test('milestone task completion triggers stage transition on the card', async ({ request }) => {
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

    // And: A card has been created from that template
    const { card, tasks } = await createCardFromTemplate(request, {
      title: 'E2E Stage Card',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    // Verify card starts at "preparation"
    expect(card.stage).toBe('preparation');

    // When: The milestone task is marked as done
    const milestoneTask = tasks.find(t => t.templateTaskRef === 'stream');
    expect(milestoneTask).toBeDefined();

    const updateRes = await request.put(`/api/tasks/${milestoneTask.id}`, {
      data: { status: 'done' },
    });
    expect(updateRes.status()).toBe(200);

    // Then: The card's stage is automatically updated to "after-event"
    const cardRes = await request.get(`/api/cards/${card.id}`);
    expect(cardRes.status()).toBe(200);
    const cardBody = await cardRes.json();
    expect(cardBody.card.stage).toBe('after-event');
  });

  test('non-milestone task completion does not trigger stage transition', async ({ request }) => {
    // Given: A card created from a template with milestone and regular tasks
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

    const { card, tasks } = await createCardFromTemplate(request, {
      title: 'E2E No Stage Change Card',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    expect(card.stage).toBe('preparation');

    // When: A regular task is marked as done
    const regularTask = tasks.find(t => t.templateTaskRef === 'regular');
    expect(regularTask).toBeDefined();

    const updateRes = await request.put(`/api/tasks/${regularTask.id}`, {
      data: { status: 'done' },
    });
    expect(updateRes.status()).toBe(200);

    // Then: The card's stage remains unchanged
    const cardRes = await request.get(`/api/cards/${card.id}`);
    expect(cardRes.status()).toBe(200);
    const cardBody = await cardRes.json();
    expect(cardBody.card.stage).toBe('preparation');
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

    const { card, tasks } = await createCardFromTemplate(request, {
      title: 'E2E No Done Card',
      anchorDate: '2026-06-15',
      templateId: template.id,
    });

    expect(card.stage).toBe('preparation');

    // When: The milestone task's description is updated (not status)
    const milestoneTask = tasks.find(t => t.templateTaskRef === 'milestone');
    const updateRes = await request.put(`/api/tasks/${milestoneTask.id}`, {
      data: { description: 'Updated description' },
    });
    expect(updateRes.status()).toBe(200);

    // Then: The card's stage remains unchanged
    const cardRes = await request.get(`/api/cards/${card.id}`);
    expect(cardRes.status()).toBe(200);
    const cardBody = await cardRes.json();
    expect(cardBody.card.stage).toBe('preparation');
  });
});

test.describe('Template instantiation - date calculation', () => {

  test('a today anchor preserves pre-creation offsets for derived scheduled classification (#106)', async ({ request }) => {
    const today = utcDateString();
    let template;
    let card;
    let tasks = [];

    try {
      template = await createTemplate(request, {
        name: 'E2E Scheduled Date Calc ' + Date.now(),
        type: 'test',
        taskDefinitions: [
          { refId: 'before', description: 'Before workflow creation', offsetDays: -2 },
          { refId: 'anchor', description: 'Anchor day', offsetDays: 0 },
          { refId: 'after', description: 'After anchor', offsetDays: 2 },
        ],
      });

      ({ card, tasks } = await createCardFromTemplate(request, {
        title: 'E2E Scheduled Date Card ' + Date.now(),
        anchorDate: today,
        templateId: template.id,
      }));

      const byRef = new Map(tasks.map((task) => [task.templateTaskRef, task]));
      expect(card.createdAt.slice(0, 10)).toBe(today);
      expect(byRef.get('before').date).toBe(utcDateString(-2));
      expect(byRef.get('before').date < card.createdAt.slice(0, 10)).toBe(true);
      expect(byRef.get('anchor').date).toBe(today);
      expect(byRef.get('after').date).toBe(utcDateString(2));
      for (const task of tasks) {
        expect(task.source).toBe('template');
        expect(task.status).toBe('todo');
        expect(task.createdAt).toBe(task.updatedAt);
      }
    } finally {
      for (const task of tasks) await request.delete('/api/tasks/' + task.id);
      if (card) {
        await request.put('/api/cards/' + card.id + '/archive');
        await request.delete('/api/cards/' + card.id);
      }
      if (template) await request.delete('/api/templates/' + template.id);
    }
  });

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

    // When: A card is created with anchorDate "2026-06-15"
    const { tasks } = await createCardFromTemplate(request, {
      title: 'E2E Date Calc Card',
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

    const { tasks } = await createCardFromTemplate(request, {
      title: 'E2E Milestone Date Card',
      anchorDate: '2026-07-20',
      templateId: template.id,
    });

    expect(tasks[0].date).toBe('2026-07-20');
  });
});

test.describe('Existing card and template tests still pass', () => {

  test('creating a card without a template still works normally', async ({ request }) => {
    const res = await request.post('/api/cards', {
      data: { title: 'No template card', anchorDate: '2026-08-01' },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.card.title).toBe('No template card');
    expect(body.card.stage).toBe('preparation');
    expect(body.card.status).toBe('active');
    expect(body.tasks).toBeUndefined();
  });

  test('creating a card with a basic template still generates tasks', async ({ request }) => {
    const template = await createTemplate(request, {
      name: 'E2E Basic Template',
      type: 'test',
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
        { refId: 'b', description: 'Task B', offsetDays: 5 },
      ],
    });

    const { card, tasks } = await createCardFromTemplate(request, {
      title: 'E2E Basic Card',
      anchorDate: '2026-05-01',
      templateId: template.id,
    });

    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task.source).toBe('template');
      expect(task.cardId).toBe(card.id);
    }
  });
});
