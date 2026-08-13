const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

// Helper: UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Helper: ISO-8601 timestamp pattern
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

// Helper: archive and delete a card
async function archiveAndDelete(request, cardId) {
  await request.put(`/api/cards/${cardId}/archive`);
  await request.delete(`/api/cards/${cardId}`);
}

test.describe('Card CRUD API', () => {
  // ──────────────────────────────────────────────────────────────────
  // POST /api/cards -- Create
  // ──────────────────────────────────────────────────────────────────

  test.describe('POST /api/cards', () => {
    test('creates a card with required fields only (title + anchorDate)', async ({ request }) => {
      const res = await request.post('/api/cards', {
        data: { title: 'ML Zoomcamp 2026', anchorDate: '2026-06-01' },
      });
      expect(res.status()).toBe(201);

      const body = await res.json();
      expect(body.card).toBeDefined();
      expect(body.card.id).toMatch(UUID_RE);
      expect(body.card.title).toBe('ML Zoomcamp 2026');
      expect(body.card.anchorDate).toBe('2026-06-01');
      expect(body.card.createdAt).toMatch(ISO_TS_RE);
      expect(body.card.updatedAt).toMatch(ISO_TS_RE);

      // No tasks key when no templateId provided
      expect(body.tasks).toBeUndefined();
    });

    test('creates a card with optional description', async ({ request }) => {
      const res = await request.post('/api/cards', {
        data: {
          title: 'Newsletter',
          anchorDate: '2026-03-01',
          description: 'Weekly newsletter',
        },
      });
      expect(res.status()).toBe(201);

      const body = await res.json();
      expect(body.card.description).toBe('Weekly newsletter');
      expect(body.card.title).toBe('Newsletter');
      expect(body.card.anchorDate).toBe('2026-03-01');
    });

    test('returns 400 when title is missing', async ({ request }) => {
      const res = await request.post('/api/cards', {
        data: { anchorDate: '2026-06-01' },
      });
      expect(res.status()).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.toLowerCase()).toContain('title');
    });

    test('returns 400 when anchorDate is missing', async ({ request }) => {
      const res = await request.post('/api/cards', {
        data: { title: 'Test' },
      });
      expect(res.status()).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.toLowerCase()).toContain('anchordate');
    });

    test('returns 400 for invalid anchorDate format', async ({ request }) => {
      const res = await request.post('/api/cards', {
        data: { title: 'Bad date', anchorDate: '06-01-2026' },
      });
      expect(res.status()).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    test('returns 400 for empty title string', async ({ request }) => {
      const res = await request.post('/api/cards', {
        data: { title: '   ', anchorDate: '2026-06-01' },
      });
      expect(res.status()).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.toLowerCase()).toContain('title');
    });

    test('returns 201 and Content-Type application/json', async ({ request }) => {
      const res = await request.post('/api/cards', {
        data: { title: 'Content-Type test', anchorDate: '2026-07-01' },
      });
      expect(res.status()).toBe(201);
      expect(res.headers()['content-type']).toBe('application/json');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/cards -- List all
  // ──────────────────────────────────────────────────────────────────

  test.describe('GET /api/cards', () => {
    test('lists all cards as an array', async ({ request }) => {
      // Ensure at least one card exists
      await request.post('/api/cards', {
        data: { title: 'List test', anchorDate: '2026-07-01' },
      });

      const res = await request.get('/api/cards');
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.cards).toBeInstanceOf(Array);
      expect(body.cards.length).toBeGreaterThan(0);
    });

    test('returns Content-Type application/json', async ({ request }) => {
      const res = await request.get('/api/cards');
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('application/json');
    });

    test('each card in the list has expected fields', async ({ request }) => {
      await request.post('/api/cards', {
        data: { title: 'Fields check', anchorDate: '2026-08-01' },
      });

      const res = await request.get('/api/cards');
      const body = await res.json();

      const card = body.cards.find((b) => b.title === 'Fields check');
      expect(card).toBeDefined();
      expect(card.id).toMatch(UUID_RE);
      expect(card.anchorDate).toBe('2026-08-01');
      expect(card.createdAt).toBeTruthy();
      expect(card.updatedAt).toBeTruthy();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/cards/:id -- Single card
  // ──────────────────────────────────────────────────────────────────

  test.describe('GET /api/cards/:id', () => {
    test('returns the card when it exists', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'Fetch me', anchorDate: '2026-07-01', description: 'desc' },
      });
      const { card } = await create.json();

      const res = await request.get(`/api/cards/${card.id}`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.card.id).toBe(card.id);
      expect(body.card.title).toBe('Fetch me');
      expect(body.card.description).toBe('desc');
      expect(body.card.anchorDate).toBe('2026-07-01');
    });

    test('returns 404 for a non-existent card', async ({ request }) => {
      const res = await request.get('/api/cards/does-not-exist');
      expect(res.status()).toBe(404);

      const body = await res.json();
      expect(body.error).toBe('Card not found');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PUT /api/cards/:id -- Update
  // ──────────────────────────────────────────────────────────────────

  test.describe('PUT /api/cards/:id', () => {
    test('updates the title of an existing card', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'Old Title', anchorDate: '2026-07-01' },
      });
      const { card: original } = await create.json();

      const res = await request.put(`/api/cards/${original.id}`, {
        data: { title: 'New Title' },
      });
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.card.title).toBe('New Title');
      expect(body.card.id).toBe(original.id);
    });

    test('updates the description', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'Desc card', anchorDate: '2026-07-01', description: 'original' },
      });
      const { card } = await create.json();

      const res = await request.put(`/api/cards/${card.id}`, {
        data: { description: 'updated description' },
      });
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.card.description).toBe('updated description');
    });

    test('updates the anchorDate', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'Date card', anchorDate: '2026-07-01' },
      });
      const { card } = await create.json();

      const res = await request.put(`/api/cards/${card.id}`, {
        data: { anchorDate: '2026-08-15' },
      });
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.card.anchorDate).toBe('2026-08-15');
    });

    test('updatedAt changes after an update', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'Timestamp card', anchorDate: '2026-07-01' },
      });
      const { card: original } = await create.json();

      // Small delay so timestamps differ
      await new Promise((r) => setTimeout(r, 50));

      const res = await request.put(`/api/cards/${original.id}`, {
        data: { title: 'Updated timestamp' },
      });
      const { card: updated } = await res.json();

      expect(updated.updatedAt).not.toBe(original.updatedAt);
    });

    test('returns 404 for a non-existent card', async ({ request }) => {
      const res = await request.put('/api/cards/does-not-exist', {
        data: { title: 'New' },
      });
      expect(res.status()).toBe(404);

      const body = await res.json();
      expect(body.error).toBe('Card not found');
    });

    test('returns 400 when body has no valid fields', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'No valid fields', anchorDate: '2026-07-01' },
      });
      const { card } = await create.json();

      const res = await request.put(`/api/cards/${card.id}`, {
        data: { unknownField: 'value' },
      });
      expect(res.status()).toBe(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // DELETE /api/cards/:id -- Delete
  // ──────────────────────────────────────────────────────────────────

  test.describe('DELETE /api/cards/:id', () => {
    test('deletes an archived card and returns 204', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'Delete me', anchorDate: '2026-07-01' },
      });
      const { card } = await create.json();

      // Archive first
      await request.put(`/api/cards/${card.id}/archive`);

      const del = await request.delete(`/api/cards/${card.id}`);
      expect(del.status()).toBe(204);

      // Verify the response body is empty
      const text = await del.text();
      expect(text).toBe('');
    });

    test('deleted card is no longer retrievable', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'Delete and verify', anchorDate: '2026-07-01' },
      });
      const { card } = await create.json();

      // Archive first, then delete
      await request.put(`/api/cards/${card.id}/archive`);
      await request.delete(`/api/cards/${card.id}`);

      const get = await request.get(`/api/cards/${card.id}`);
      expect(get.status()).toBe(404);
    });

    test('returns 400 when deleting a non-archived card', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'Active card', anchorDate: '2026-07-01' },
      });
      const { card } = await create.json();

      const del = await request.delete(`/api/cards/${card.id}`);
      expect(del.status()).toBe(400);

      const body = await del.json();
      expect(body.error).toBe('Only archived cards can be deleted');
    });

    test('returns 404 for a non-existent card', async ({ request }) => {
      const res = await request.delete('/api/cards/does-not-exist');
      expect(res.status()).toBe(404);

      const body = await res.json();
      expect(body.error).toBe('Card not found');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/cards/:id/tasks -- Card tasks
  // ──────────────────────────────────────────────────────────────────

  test.describe('GET /api/cards/:id/tasks', () => {
    test('returns an empty tasks array for a card with no tasks', async ({ request }) => {
      const create = await request.post('/api/cards', {
        data: { title: 'No tasks card', anchorDate: '2026-07-01' },
      });
      const { card } = await create.json();

      const res = await request.get(`/api/cards/${card.id}/tasks`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.tasks).toBeInstanceOf(Array);
      expect(body.tasks).toHaveLength(0);
    });

    test('returns tasks that belong to the card', async ({ request }) => {
      // Create a template with 2 tasks
      const tmplRes = await request.post('/__e2e__/template-fixtures', {
        data: {
          name: 'Tasks test', type: 'test',
          taskDefinitions: [
            { refId: 'a1', description: 'Task A', offsetDays: 0 },
            { refId: 'a2', description: 'Task B', offsetDays: 1 },
          ],
        },
      });
      const { template } = await tmplRes.json();

      // Create card with that template to generate tasks
      const create = await request.post('/api/cards', {
        data: { title: 'Has tasks', anchorDate: '2026-05-01', templateId: template.id },
      });
      const { card } = await create.json();

      const res = await request.get(`/api/cards/${card.id}/tasks`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
      expect(body.tasks.every((t) => t.cardId === card.id)).toBe(true);
    });

    test('returns 404 for a non-existent card', async ({ request }) => {
      const res = await request.get('/api/cards/does-not-exist/tasks');
      expect(res.status()).toBe(404);

      const body = await res.json();
      expect(body.error).toBe('Card not found');
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Card with template
// ──────────────────────────────────────────────────────────────────

test.describe('Card with template', () => {
  test('creates card from template and generates tasks with correct dates', async ({ request }) => {
    // Create template with offsets -7, 0, +3
    const tmplRes = await request.post('/__e2e__/template-fixtures', {
      data: {
        name: 'E2E Event', type: 'event',
        taskDefinitions: [
          { refId: 't1', description: 'Prepare', offsetDays: -7 },
          { refId: 't2', description: 'Run event', offsetDays: 0 },
          { refId: 't3', description: 'Follow up', offsetDays: 3 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    // Create card with anchorDate 2026-04-15
    const res = await request.post('/api/cards', {
      data: {
        title: 'Community Meetup',
        anchorDate: '2026-04-15',
        templateId: template.id,
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();

    // Verify card
    expect(body.card).toBeDefined();
    expect(body.card.id).toMatch(UUID_RE);
    expect(body.card.title).toBe('Community Meetup');
    expect(body.card.templateId).toBe(template.id);

    // Verify tasks array is returned
    expect(body.tasks).toBeDefined();
    expect(body.tasks).toHaveLength(3);

    // Verify task dates: anchor 2026-04-15 with offsets -7, 0, +3
    const dates = body.tasks.map((t) => t.date).sort();
    expect(dates).toEqual(['2026-04-08', '2026-04-15', '2026-04-18']);
  });

  test('template tasks have source "template" and correct cardId', async ({ request }) => {
    const tmplRes = await request.post('/__e2e__/template-fixtures', {
      data: {
        name: 'Source check template', type: 'test',
        taskDefinitions: [
          { refId: 's1', description: 'Task 1', offsetDays: 0 },
          { refId: 's2', description: 'Task 2', offsetDays: 5 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    const res = await request.post('/api/cards', {
      data: {
        title: 'Source check card',
        anchorDate: '2026-05-01',
        templateId: template.id,
      },
    });
    const body = await res.json();

    expect(body.tasks).toHaveLength(2);
    for (const task of body.tasks) {
      expect(task.source).toBe('template');
      expect(task.cardId).toBe(body.card.id);
    }
  });

  test('template tasks are retrievable via GET /api/cards/:id/tasks', async ({ request }) => {
    const tmplRes = await request.post('/__e2e__/template-fixtures', {
      data: {
        name: 'Retrieve template', type: 'test',
        taskDefinitions: [
          { refId: 'r1', description: 'Book venue', offsetDays: -14 },
          { refId: 'r2', description: 'Send invites', offsetDays: -7 },
          { refId: 'r3', description: 'Run event', offsetDays: 0 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    const createRes = await request.post('/api/cards', {
      data: {
        title: 'Conference',
        anchorDate: '2026-04-15',
        templateId: template.id,
      },
    });
    const { card, tasks: createdTasks } = await createRes.json();

    // Verify via the sub-route
    const tasksRes = await request.get(`/api/cards/${card.id}/tasks`);
    expect(tasksRes.status()).toBe(200);

    const tasksBody = await tasksRes.json();
    expect(tasksBody.tasks).toHaveLength(3);
    expect(tasksBody.tasks.every((t) => t.source === 'template')).toBe(true);
    expect(tasksBody.tasks.every((t) => t.cardId === card.id)).toBe(true);

    // Verify dates match what was returned at creation
    const fetchedDates = tasksBody.tasks.map((t) => t.date).sort();
    const createdDates = createdTasks.map((t) => t.date).sort();
    expect(fetchedDates).toEqual(createdDates);
  });

  test('template tasks have correct templateTaskRef from refId', async ({ request }) => {
    const tmplRes = await request.post('/__e2e__/template-fixtures', {
      data: {
        name: 'RefId template', type: 'test',
        taskDefinitions: [
          { refId: 'ref-alpha', description: 'Alpha task', offsetDays: -3 },
          { refId: 'ref-beta', description: 'Beta task', offsetDays: 0 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    const res = await request.post('/api/cards', {
      data: {
        title: 'RefId card',
        anchorDate: '2026-06-10',
        templateId: template.id,
      },
    });
    const body = await res.json();

    const refs = body.tasks.map((t) => t.templateTaskRef).sort();
    expect(refs).toEqual(['ref-alpha', 'ref-beta']);
  });

  test('returns 404 when templateId does not exist', async ({ request }) => {
    const res = await request.post('/api/cards', {
      data: {
        title: 'Bad template',
        anchorDate: '2026-01-01',
        templateId: 'nonexistent-template-id',
      },
    });
    expect(res.status()).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Template not found');
  });

  test('no card is created when templateId does not exist', async ({ request }) => {
    // Attempt to create with bad template
    const rejectedTitle = 'Should not exist from bad template';
    await request.post('/api/cards', {
      data: {
        title: rejectedTitle,
        anchorDate: '2026-01-01',
        templateId: 'nonexistent-template-id',
      },
    });

    // Verify the rejected payload was not persisted. Other E2E specs share the
    // same test server and may create/delete unrelated cards in parallel.
    const after = await request.get('/api/cards');
    const afterBody = await after.json();
    expect(afterBody.cards.some((card) => card.title === rejectedTitle)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// Old /api/projects endpoints return 404
// ──────────────────────────────────────────────────────────────────

test.describe('Old project endpoints return 404', () => {
  test('GET /api/projects returns 404', async ({ request }) => {
    const res = await request.get('/api/projects');
    expect(res.status()).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────
// Tasks filtered by cardId
// ──────────────────────────────────────────────────────────────────

test.describe('Tasks filtered by cardId', () => {
  test('GET /api/tasks?cardId returns tasks for that card', async ({ request }) => {
    // Create a card with template tasks
    const tmplRes = await request.post('/__e2e__/template-fixtures', {
      data: {
        name: 'Filter test template', type: 'test',
        taskDefinitions: [
          { refId: 'f1', description: 'Filter task 1', offsetDays: 0 },
          { refId: 'f2', description: 'Filter task 2', offsetDays: 1 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    const createRes = await request.post('/api/cards', {
      data: {
        title: 'Filter card',
        anchorDate: '2026-09-01',
        templateId: template.id,
      },
    });
    const { card } = await createRes.json();

    const res = await request.get(`/api/tasks?cardId=${card.id}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.tasks.length).toBe(2);
    for (const task of body.tasks) {
      expect(task.cardId).toBe(card.id);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Frontend navigation
// ──────────────────────────────────────────────────────────────────

test.describe('Canonical workflow page', () => {
  test('navigating to #/cards opens the Workflows section in the canonical Tasks surface', async ({ page }) => {
    await page.goto('/#/cards');
    await expect(page.locator('#library-title')).toHaveText('Tasks - Cards');
    await expect(page).toHaveURL(/\/#\/cards$/);
    await expect(page.locator('.ops-workflows-board')).toBeVisible();
    await expect(page.locator('[data-tasks-section="workflows"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('nav a[href="#/cards"]')).toHaveCount(0);
  });

  test('primary navigation exposes one Tasks entry instead of a second Cards shell', async ({ page }) => {
    await page.goto('/#/cards');
    const tasksNavigation = page.getByRole('button', { name: 'Tasks', exact: true });
    await expect(tasksNavigation).toHaveCount(1);
    await expect(tasksNavigation).toBeVisible();
    await expect(tasksNavigation).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('nav a[href="#/cards"]')).toHaveCount(0);
    await expect(page.locator('nav a[href="#/projects"]')).toHaveCount(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Existing routes
// ──────────────────────────────────────────────────────────────────

test.describe('Existing routes', () => {
  test('GET /api/health returns 200 with status ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('GET / returns 200 with text/html Content-Type', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
  });
});

// ──────────────────────────────────────────────────────────────────
// Card data model: new fields, stage, archive, delete guard
// (Tests for issue #18)
// ──────────────────────────────────────────────────────────────────

test.describe('Card data model updates (issue #18)', () => {

  // Scenario: Create a card with all new fields
  test('creates a card with all new fields (emoji, tags, references, cardLinks)', async ({ request }) => {
    const res = await request.post('/api/cards', {
      data: {
        title: 'Newsletter Mar 2026',
        anchorDate: '2026-03-15',
        emoji: '📰',
        tags: ['newsletter'],
        references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
        cardLinks: [{ name: 'Luma', url: '' }],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.card.emoji).toBe('📰');
    expect(body.card.tags).toEqual(['newsletter']);
    expect(body.card.references).toEqual([{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
    expect(body.card.cardLinks).toEqual([{ name: 'Luma', url: '' }]);
    expect(body.card.stage).toBe('preparation');
    expect(body.card.status).toBe('active');
  });

  // Scenario: Create a card with only required fields (backward compatibility)
  test('creates a card with only required fields -- defaults stage and status', async ({ request }) => {
    const res = await request.post('/api/cards', {
      data: { title: 'Simple Card', anchorDate: '2026-04-01' },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.card.stage).toBe('preparation');
    expect(body.card.status).toBe('active');
    expect(body.card.emoji).toBeUndefined();
    expect(body.card.tags).toBeUndefined();
    expect(body.card.references).toBeUndefined();
    expect(body.card.cardLinks).toBeUndefined();
  });

  // Scenario: Update a card stage
  test('updates a card stage from preparation to announced', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Stage test', anchorDate: '2026-05-01' },
    });
    const { card } = await create.json();
    expect(card.stage).toBe('preparation');

    const res = await request.put(`/api/cards/${card.id}`, {
      data: { stage: 'announced' },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.card.stage).toBe('announced');
  });

  // Scenario: Reject invalid stage value
  test('rejects invalid stage value with 400', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Invalid stage', anchorDate: '2026-05-01' },
    });
    const { card } = await create.json();

    const res = await request.put(`/api/cards/${card.id}`, {
      data: { stage: 'invalid-stage' },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid stage');
  });

  // Scenario: Reject invalid status value
  test('rejects invalid status value with 400', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Invalid status', anchorDate: '2026-05-01' },
    });
    const { card } = await create.json();

    const res = await request.put(`/api/cards/${card.id}`, {
      data: { status: 'invalid-status' },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid status');
  });

  // Scenario: Update card with references and cardLinks
  test('updates card with references and cardLinks', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Links update', anchorDate: '2026-05-01' },
    });
    const { card } = await create.json();

    const res = await request.put(`/api/cards/${card.id}`, {
      data: {
        references: [{ name: 'Process doc', url: 'https://docs.google.com/proc' }],
        cardLinks: [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }],
      },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.card.references).toEqual([{ name: 'Process doc', url: 'https://docs.google.com/proc' }]);
    expect(body.card.cardLinks).toEqual([{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }]);
  });

  // Scenario: Archive a card via the archive endpoint
  test('archives a card via PUT /api/cards/:id/archive', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Archive me', anchorDate: '2026-05-01' },
    });
    const { card } = await create.json();
    expect(card.status).toBe('active');

    const res = await request.put(`/api/cards/${card.id}/archive`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.card.status).toBe('archived');
    expect(body.card.id).toBe(card.id);
  });

  // Scenario: Archive returns 404 for non-existent card
  test('archive returns 404 for non-existent card', async ({ request }) => {
    const res = await request.put('/api/cards/does-not-exist/archive');
    expect(res.status()).toBe(404);
  });

  // Scenario: Delete a non-archived card is rejected
  test('delete of non-archived card returns 400', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Cannot delete active', anchorDate: '2026-05-01' },
    });
    const { card } = await create.json();

    const res = await request.delete(`/api/cards/${card.id}`);
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBe('Only archived cards can be deleted');
  });

  // Scenario: Delete an archived card succeeds
  test('delete of archived card returns 204', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Archive then delete', anchorDate: '2026-05-01' },
    });
    const { card } = await create.json();

    // Archive first
    await request.put(`/api/cards/${card.id}/archive`);

    const del = await request.delete(`/api/cards/${card.id}`);
    expect(del.status()).toBe(204);

    // Verify gone
    const get = await request.get(`/api/cards/${card.id}`);
    expect(get.status()).toBe(404);
  });

  // Scenario: Retrieve a card with new fields via GET
  test('GET returns all new fields that were set on creation', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: {
        title: 'Full GET test',
        anchorDate: '2026-06-01',
        emoji: '🎙️',
        tags: ['podcast', 'weekly'],
        references: [{ name: 'Docs', url: 'https://example.com/docs' }],
        cardLinks: [{ name: 'YouTube', url: 'https://youtube.com/x' }],
      },
    });
    const { card } = await create.json();

    const res = await request.get(`/api/cards/${card.id}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.card.emoji).toBe('🎙️');
    expect(body.card.tags).toEqual(['podcast', 'weekly']);
    expect(body.card.references).toEqual([{ name: 'Docs', url: 'https://example.com/docs' }]);
    expect(body.card.cardLinks).toEqual([{ name: 'YouTube', url: 'https://youtube.com/x' }]);
    expect(body.card.stage).toBe('preparation');
    expect(body.card.status).toBe('active');
  });

  // Scenario: Existing card without new fields still works
  test('card without new fields still returns correctly', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Minimal card', anchorDate: '2026-01-01' },
    });
    const { card } = await create.json();

    const res = await request.get(`/api/cards/${card.id}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.card.title).toBe('Minimal card');
    // New optional fields are not present
    expect(body.card.emoji).toBeUndefined();
    expect(body.card.tags).toBeUndefined();
    expect(body.card.references).toBeUndefined();
    expect(body.card.cardLinks).toBeUndefined();
  });

  // Test all valid stages
  test('can cycle through all valid stages', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Stage cycle', anchorDate: '2026-06-01' },
    });
    const { card } = await create.json();

    const stages = ['announced', 'after-event', 'done'];
    for (const stage of stages) {
      const res = await request.put(`/api/cards/${card.id}`, {
        data: { stage },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.card.stage).toBe(stage);
    }
  });

  // Test updating emoji and tags
  test('updates emoji and tags via PUT', async ({ request }) => {
    const create = await request.post('/api/cards', {
      data: { title: 'Emoji tags update', anchorDate: '2026-06-01' },
    });
    const { card } = await create.json();

    const res = await request.put(`/api/cards/${card.id}`, {
      data: { emoji: '📰', tags: ['newsletter', 'weekly'] },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.card.emoji).toBe('📰');
    expect(body.card.tags).toEqual(['newsletter', 'weekly']);
  });
});
