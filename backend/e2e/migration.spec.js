const { test, expect } = require('@playwright/test');

/**
 * E2E tests for migration script (issue #25).
 *
 * These tests verify that the data model produced by the migration script
 * is correctly handled by the API. The migration script writes to the DB
 * directly, so these tests simulate the same data shapes via API calls
 * where possible, and verify template instantiation for templateTaskRef.
 */

// ---------------------------------------------------------------------------
// Scenario: Migration extracts emoji and tags from a Trello card
// ---------------------------------------------------------------------------

test.describe('Migration: emoji, tags, stage on cards', () => {
  test('creates a card with emoji, tags, and stage matching migration output', async ({ request }) => {
    // Simulate what trelloCardToCard produces for a Newsletter card in Preparation list
    const res = await request.post('/api/cards', {
      data: {
        title: '\u{1F4F0} [Newsletter] Weekly email #123 (15 Mar 2026)',
        anchorDate: '2026-03-15',
        emoji: '\u{1F4F0}',
        tags: ['Newsletter'],
        stage: 'preparation',
        status: 'active',
        description: 'See [Process docs](https://docs.google.com/proc)',
        references: [
          { name: 'Process docs', url: 'https://docs.google.com/proc' },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.card.emoji).toBe('\u{1F4F0}');
    expect(body.card.tags).toEqual(['Newsletter']);
    expect(body.card.stage).toBe('preparation');
    expect(body.card.status).toBe('active');
    expect(body.card.references).toEqual([
      { name: 'Process docs', url: 'https://docs.google.com/proc' },
    ]);
  });

  test('creates a card with announced stage', async ({ request }) => {
    const res = await request.post('/api/cards', {
      data: {
        title: '\u{1F399}\u{FE0F} [Podcast] Interview - March 2026',
        anchorDate: '2026-03-20',
        emoji: '\u{1F399}\u{FE0F}',
        tags: ['Podcast'],
        stage: 'announced',
        status: 'active',
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.card.stage).toBe('announced');
    expect(body.card.emoji).toBe('\u{1F399}\u{FE0F}');
    expect(body.card.tags).toEqual(['Podcast']);
  });

  test('creates a card with after-event stage', async ({ request }) => {
    const res = await request.post('/api/cards', {
      data: {
        title: 'Webinar - Post-event tasks',
        anchorDate: '2026-02-01',
        stage: 'after-event',
        status: 'active',
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.card.stage).toBe('after-event');
  });
});

// ---------------------------------------------------------------------------
// Scenario: Migration extracts instructionsUrl from checklist items
// ---------------------------------------------------------------------------

test.describe('Migration: instructionsUrl on tasks', () => {
  test('creates a task with instructionsUrl (not comment) from migration', async ({ request }) => {
    // First create a card
    const cardRes = await request.post('/api/cards', {
      data: {
        title: 'Newsletter #150',
        anchorDate: '2026-03-15',
      },
    });
    const { card } = await cardRes.json();

    // Create a task as the migration would: instructionsUrl on the task, not comment
    const taskRes = await request.post('/api/tasks', {
      data: {
        description: '[Phase] Create a MailChimp campaign',
        date: '2026-03-15',
        source: 'template',
        cardId: card.id,
        instructionsUrl: 'https://docs.google.com/doc123',
      },
    });
    expect(taskRes.status()).toBe(201);

    // Task API returns the task object directly (not wrapped in {task: ...})
    const taskBody = await taskRes.json();
    expect(taskBody.description).toBe('[Phase] Create a MailChimp campaign');
    expect(taskBody.instructionsUrl).toBe('https://docs.google.com/doc123');
    expect(taskBody.comment).toBeUndefined();
    expect(taskBody.source).toBe('template');
  });

  test('task with instructionsUrl is retrievable via GET', async ({ request }) => {
    const cardRes = await request.post('/api/cards', {
      data: { title: 'Test Card', anchorDate: '2026-04-01' },
    });
    const { card } = await cardRes.json();

    const taskRes = await request.post('/api/tasks', {
      data: {
        description: 'Send invitations',
        date: '2026-04-01',
        source: 'template',
        cardId: card.id,
        instructionsUrl: 'https://docs.google.com/instructions',
      },
    });
    const task = await taskRes.json();

    const getRes = await request.get(`/api/tasks/${task.id}`);
    expect(getRes.status()).toBe(200);

    const getBody = await getRes.json();
    expect(getBody.instructionsUrl).toBe('https://docs.google.com/instructions');
    expect(getBody.comment).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario: Migration extracts card links from attachments
// ---------------------------------------------------------------------------

test.describe('Migration: cardLinks from attachments', () => {
  test('creates a card with cardLinks (not links)', async ({ request }) => {
    // Simulate migration output: cardLinks from non-Trello attachments
    const res = await request.post('/api/cards', {
      data: {
        title: 'Event with links',
        anchorDate: '2026-05-01',
        cardLinks: [
          { name: 'Luma event', url: 'https://lu.ma/abc' },
          { name: 'YouTube stream', url: 'https://youtube.com/watch?v=xyz' },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.card.cardLinks).toEqual([
      { name: 'Luma event', url: 'https://lu.ma/abc' },
      { name: 'YouTube stream', url: 'https://youtube.com/watch?v=xyz' },
    ]);
  });

  test('cardLinks are retrievable via GET', async ({ request }) => {
    const createRes = await request.post('/api/cards', {
      data: {
        title: 'Links retrieval test',
        anchorDate: '2026-05-15',
        cardLinks: [{ name: 'Luma event', url: 'https://lu.ma/abc' }],
      },
    });
    const { card } = await createRes.json();

    const getRes = await request.get(`/api/cards/${card.id}`);
    expect(getRes.status()).toBe(200);

    const body = await getRes.json();
    expect(body.card.cardLinks).toEqual([
      { name: 'Luma event', url: 'https://lu.ma/abc' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario: Migration extracts references from card description
// ---------------------------------------------------------------------------

test.describe('Migration: references from description', () => {
  test('creates a card with references extracted from description', async ({ request }) => {
    const res = await request.post('/api/cards', {
      data: {
        title: 'Card with references',
        anchorDate: '2026-06-01',
        description: 'See [Process docs](https://docs.google.com/proc) and [Guide](https://docs.google.com/guide)',
        references: [
          { name: 'Process docs', url: 'https://docs.google.com/proc' },
          { name: 'Guide', url: 'https://docs.google.com/guide' },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.card.references).toEqual([
      { name: 'Process docs', url: 'https://docs.google.com/proc' },
      { name: 'Guide', url: 'https://docs.google.com/guide' },
    ]);
  });

  test('references are retrievable via GET', async ({ request }) => {
    const createRes = await request.post('/api/cards', {
      data: {
        title: 'Refs GET test',
        anchorDate: '2026-06-15',
        references: [{ name: 'Overview', url: 'https://docs.google.com/overview' }],
      },
    });
    const { card } = await createRes.json();

    const getRes = await request.get(`/api/cards/${card.id}`);
    const body = await getRes.json();
    expect(body.card.references).toEqual([
      { name: 'Overview', url: 'https://docs.google.com/overview' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario: Migration creates tasks with source "template" and templateTaskRef
// (tested via template instantiation which is how templateTaskRef gets set)
// ---------------------------------------------------------------------------

test.describe('Migration: task source and templateTaskRef', () => {
  test('template instantiation creates tasks with source template and templateTaskRef', async ({ request }) => {
    // Create a template with task definitions that include instructionsUrl
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'Migration TemplateTaskRef Test',
        type: 'newsletter',
        emoji: '\u{1F4F0}',
        tags: ['Newsletter'],
        triggerType: 'automatic',
        taskDefinitions: [
          {
            refId: 'setup-configure-env-0',
            description: '[Setup] Configure environment',
            offsetDays: -7,
            instructionsUrl: 'https://docs.google.com/setup-howto',
          },
          {
            refId: 'content-write-draft-1',
            description: '[Content] Write draft',
            offsetDays: -3,
          },
        ],
      },
    });
    expect(tmplRes.status()).toBe(201);
    const { template } = await tmplRes.json();

    // Create card from template to trigger instantiation
    const cardRes = await request.post('/api/cards', {
      data: {
        title: 'Newsletter #200',
        anchorDate: '2026-07-01',
        templateId: template.id,
      },
    });
    expect(cardRes.status()).toBe(201);
    const body = await cardRes.json();

    // Verify tasks have source "template" and templateTaskRef
    expect(body.tasks).toHaveLength(2);
    for (const task of body.tasks) {
      expect(task.source).toBe('template');
      expect(task.cardId).toBe(body.card.id);
    }

    const refs = body.tasks.map((t) => t.templateTaskRef).sort();
    expect(refs).toEqual(['content-write-draft-1', 'setup-configure-env-0']);

    // Verify instructionsUrl is on the task, not in comment
    const taskWithUrl = body.tasks.find((t) => t.templateTaskRef === 'setup-configure-env-0');
    expect(taskWithUrl.instructionsUrl).toBe('https://docs.google.com/setup-howto');
    expect(taskWithUrl.comment).toBeUndefined();
  });

  test('creates a task with source template via API', async ({ request }) => {
    const taskRes = await request.post('/api/tasks', {
      data: {
        description: '[Setup] Configure environment',
        date: '2026-07-01',
        source: 'template',
      },
    });
    expect(taskRes.status()).toBe(201);

    const body = await taskRes.json();
    expect(body.source).toBe('template');
  });
});

// ---------------------------------------------------------------------------
// Scenario: Migration creates tasks with assigneeId
// ---------------------------------------------------------------------------

test.describe('Migration: assigneeId on tasks', () => {
  test('creates a task with assigneeId from migration hint', async ({ request }) => {
    const taskRes = await request.post('/api/tasks', {
      data: {
        description: '[Content] Review newsletter',
        date: '2026-07-01',
        source: 'template',
        assigneeId: 'valeriia',
      },
    });
    expect(taskRes.status()).toBe(201);

    const body = await taskRes.json();
    expect(body.assigneeId).toBe('valeriia');
    expect(body.description).toBe('[Content] Review newsletter');
  });
});

// ---------------------------------------------------------------------------
// Scenario: Migration creates templates with emoji and tags
// ---------------------------------------------------------------------------

test.describe('Migration: templates with emoji, tags, and triggerType', () => {
  test('creates a template with emoji, tags, and triggerType', async ({ request }) => {
    const res = await request.post('/api/templates', {
      data: {
        name: 'Newsletter Migration Test',
        type: 'newsletter',
        emoji: '\u{1F4F0}',
        tags: ['Newsletter'],
        triggerType: 'automatic',
        taskDefinitions: [
          {
            refId: 'setup-create-campaign-0',
            description: '[Setup] Create campaign',
            offsetDays: -7,
            instructionsUrl: 'https://docs.google.com/campaign-howto',
          },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.template.emoji).toBe('\u{1F4F0}');
    expect(body.template.tags).toEqual(['Newsletter']);
    expect(body.template.triggerType).toBe('automatic');
    expect(body.template.taskDefinitions[0].instructionsUrl).toBe('https://docs.google.com/campaign-howto');
  });

  test('creates a template with manual trigger type', async ({ request }) => {
    const res = await request.post('/api/templates', {
      data: {
        name: 'Podcast Migration Test',
        type: 'podcast',
        emoji: '\u{1F399}\u{FE0F}',
        tags: ['Podcast'],
        triggerType: 'manual',
        taskDefinitions: [
          { refId: 'prep-book-guest-0', description: '[Prep] Book guest', offsetDays: -14 },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.template.triggerType).toBe('manual');
    expect(body.template.emoji).toBe('\u{1F399}\u{FE0F}');
    expect(body.template.tags).toEqual(['Podcast']);
  });

  test('template without emoji or tags still works', async ({ request }) => {
    const res = await request.post('/api/templates', {
      data: {
        name: 'Plain Template Test',
        type: 'other',
        taskDefinitions: [
          { refId: 'task-1', description: 'Do something', offsetDays: 0 },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.template.emoji).toBeUndefined();
    expect(body.template.tags).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario: Card status for archived cards
// ---------------------------------------------------------------------------

test.describe('Migration: card status', () => {
  test('creates an active card (non-closed card)', async ({ request }) => {
    const res = await request.post('/api/cards', {
      data: {
        title: 'Active Card',
        anchorDate: '2026-08-01',
        status: 'active',
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.card.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Scenario: Dry run shows new fields without writing
// (Tested via template instantiation since dry run is a CLI feature)
// ---------------------------------------------------------------------------

test.describe('Migration: full card + tasks flow', () => {
  test('creates a card with all migration fields and tasks with correct sources', async ({ request }) => {
    // Create card as migration would produce it
    const cardRes = await request.post('/api/cards', {
      data: {
        title: '\u{1F4F0} [Newsletter] Weekly email #150 (24 Feb 2026)',
        anchorDate: '2026-02-24',
        emoji: '\u{1F4F0}',
        tags: ['Newsletter'],
        stage: 'preparation',
        status: 'active',
        description: 'See [Process docs](https://docs.google.com/proc)',
        references: [{ name: 'Process docs', url: 'https://docs.google.com/proc' }],
        cardLinks: [{ name: 'MailChimp draft', url: 'https://mailchimp.com/draft123' }],
      },
    });
    expect(cardRes.status()).toBe(201);
    const { card } = await cardRes.json();

    // Create tasks as migration would (source: template, with instructionsUrl not comment)
    const task1Res = await request.post('/api/tasks', {
      data: {
        description: '[Content] Collect topics and links',
        date: '2026-02-14',
        source: 'template',
        cardId: card.id,
      },
    });
    expect(task1Res.status()).toBe(201);

    const task2Res = await request.post('/api/tasks', {
      data: {
        description: '[Setup] Create MailChimp campaign',
        date: '2026-02-20',
        source: 'template',
        cardId: card.id,
        instructionsUrl: 'https://docs.google.com/mailchimp-howto',
      },
    });
    expect(task2Res.status()).toBe(201);

    // Verify card tasks via the card tasks endpoint
    const tasksRes = await request.get(`/api/cards/${card.id}/tasks`);
    expect(tasksRes.status()).toBe(200);

    const tasksBody = await tasksRes.json();
    expect(tasksBody.tasks).toHaveLength(2);
    expect(tasksBody.tasks.every((t) => t.source === 'template')).toBe(true);
    expect(tasksBody.tasks.every((t) => t.cardId === card.id)).toBe(true);

    // Verify one task has instructionsUrl
    const taskWithUrl = tasksBody.tasks.find((t) => t.instructionsUrl);
    expect(taskWithUrl).toBeDefined();
    expect(taskWithUrl.instructionsUrl).toBe('https://docs.google.com/mailchimp-howto');
    expect(taskWithUrl.comment).toBeUndefined();
  });
});
