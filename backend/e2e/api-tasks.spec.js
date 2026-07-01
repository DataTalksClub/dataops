const { test, expect } = require('@playwright/test');

// Helper: UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Helper: ISO-8601 timestamp pattern
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

test.describe('Task data model — new fields and validation', () => {
  // ──────────────────────────────────────────────────────────────────
  // Scenario: Create a task with all new fields
  // ──────────────────────────────────────────────────────────────────

  test('creates a task with all new fields', async ({ request }) => {
    const res = await request.post('/api/tasks', {
      data: {
        description: 'Create Luma event',
        date: '2026-04-01',
        instructionsUrl: 'https://docs.google.com/luma-howto',
        link: 'https://luma.com/event-123',
        requiredLinkName: 'Luma',
        assigneeId: 'user-grace',
        tags: ['webinar', 'community'],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    expect(body.description).toBe('Create Luma event');
    expect(body.date).toBe('2026-04-01');
    expect(body.status).toBe('todo');
    expect(body.source).toBe('manual');
    expect(body.instructionsUrl).toBe('https://docs.google.com/luma-howto');
    expect(body.link).toBe('https://luma.com/event-123');
    expect(body.requiredLinkName).toBe('Luma');
    expect(body.assigneeId).toBe('user-grace');
    expect(body.tags).toEqual(['webinar', 'community']);
    expect(body.createdAt).toMatch(ISO_TS_RE);
    expect(body.updatedAt).toMatch(ISO_TS_RE);
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Create a task with only required fields (backward compatibility)
  // ──────────────────────────────────────────────────────────────────

  test('creates a task with only required fields (backward compatibility)', async ({ request }) => {
    const res = await request.post('/api/tasks', {
      data: { description: 'Simple task', date: '2026-04-01' },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    expect(body.description).toBe('Simple task');
    expect(body.status).toBe('todo');
    expect(body.source).toBe('manual');
    // New fields should be absent (not null, just missing)
    expect(body.instructionsUrl).toBeUndefined();
    expect(body.link).toBeUndefined();
    expect(body.requiredLinkName).toBeUndefined();
    expect(body.assigneeId).toBeUndefined();
    expect(body.tags).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Update a task to add new fields
  // ──────────────────────────────────────────────────────────────────

  test('updates a task to add new fields', async ({ request }) => {
    // Create a minimal task
    const createRes = await request.post('/api/tasks', {
      data: { description: 'Base task', date: '2026-04-01' },
    });
    const created = await createRes.json();

    // Update with new fields
    const updateRes = await request.put(`/api/tasks/${created.id}`, {
      data: {
        instructionsUrl: 'https://docs.google.com/guide',
        assigneeId: 'user-valeriia',
        tags: ['newsletter'],
      },
    });
    expect(updateRes.status()).toBe(200);

    const body = await updateRes.json();
    expect(body.instructionsUrl).toBe('https://docs.google.com/guide');
    expect(body.assigneeId).toBe('user-valeriia');
    expect(body.tags).toEqual(['newsletter']);
    // Other fields unchanged
    expect(body.description).toBe('Base task');
    expect(body.date).toBe('2026-04-01');
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Mark a task as done when requiredLinkName is set but link is empty
  // ──────────────────────────────────────────────────────────────────

  test('returns 400 when marking done with requiredLinkName set but link empty', async ({ request }) => {
    const createRes = await request.post('/api/tasks', {
      data: {
        description: 'Create Luma event',
        date: '2026-04-01',
        requiredLinkName: 'Luma',
      },
    });
    const created = await createRes.json();

    const updateRes = await request.put(`/api/tasks/${created.id}`, {
      data: { status: 'done' },
    });
    expect(updateRes.status()).toBe(400);

    const body = await updateRes.json();
    expect(body.error).toBe("Cannot mark task as done: required link 'Luma' is not filled");
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Mark a task as done by providing the link in the same request
  // ──────────────────────────────────────────────────────────────────

  test('allows done when providing link in the same request', async ({ request }) => {
    const createRes = await request.post('/api/tasks', {
      data: {
        description: 'Create Luma event',
        date: '2026-04-01',
        requiredLinkName: 'Luma',
      },
    });
    const created = await createRes.json();

    const updateRes = await request.put(`/api/tasks/${created.id}`, {
      data: { status: 'done', link: 'https://luma.com/event' },
    });
    expect(updateRes.status()).toBe(200);

    const body = await updateRes.json();
    expect(body.status).toBe('done');
    expect(body.link).toBe('https://luma.com/event');
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Mark a task as done when link was previously filled
  // ──────────────────────────────────────────────────────────────────

  test('allows done when link was previously filled', async ({ request }) => {
    const createRes = await request.post('/api/tasks', {
      data: {
        description: 'Create Luma event',
        date: '2026-04-01',
        requiredLinkName: 'Luma',
        link: 'https://luma.com/event',
      },
    });
    const created = await createRes.json();

    const updateRes = await request.put(`/api/tasks/${created.id}`, {
      data: { status: 'done' },
    });
    expect(updateRes.status()).toBe(200);

    const body = await updateRes.json();
    expect(body.status).toBe('done');
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Mark a task as done when requiredLinkName is not set
  // ──────────────────────────────────────────────────────────────────

  test('allows done when requiredLinkName is not set', async ({ request }) => {
    const createRes = await request.post('/api/tasks', {
      data: { description: 'Normal task', date: '2026-04-01' },
    });
    const created = await createRes.json();

    const updateRes = await request.put(`/api/tasks/${created.id}`, {
      data: { status: 'done' },
    });
    expect(updateRes.status()).toBe(200);

    const body = await updateRes.json();
    expect(body.status).toBe('done');
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Filter tasks by archived status
  // ──────────────────────────────────────────────────────────────────

  test('filters tasks by archived status', async ({ request }) => {
    // Create a task and set it to archived
    const createRes = await request.post('/api/tasks', {
      data: { description: 'Archive me', date: '2098-01-01' },
    });
    const created = await createRes.json();

    await request.put(`/api/tasks/${created.id}`, {
      data: { status: 'archived' },
    });

    const listRes = await request.get('/api/tasks?status=archived');
    expect(listRes.status()).toBe(200);

    const body = await listRes.json();
    expect(body.tasks.length).toBeGreaterThanOrEqual(1);
    const found = body.tasks.find((t) => t.id === created.id);
    expect(found).toBeDefined();
    expect(found.status).toBe('archived');
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Retrieve a task with new fields via GET
  // ──────────────────────────────────────────────────────────────────

  test('retrieves a task with all new fields via GET', async ({ request }) => {
    const createRes = await request.post('/api/tasks', {
      data: {
        description: 'Full fields task',
        date: '2026-04-01',
        instructionsUrl: 'https://docs.google.com/howto',
        link: 'https://example.com/link',
        requiredLinkName: 'Example',
        assigneeId: 'user-1',
        tags: ['tag1', 'tag2'],
      },
    });
    const created = await createRes.json();

    const getRes = await request.get(`/api/tasks/${created.id}`);
    expect(getRes.status()).toBe(200);

    const body = await getRes.json();
    expect(body.id).toBe(created.id);
    expect(body.instructionsUrl).toBe('https://docs.google.com/howto');
    expect(body.link).toBe('https://example.com/link');
    expect(body.requiredLinkName).toBe('Example');
    expect(body.assigneeId).toBe('user-1');
    expect(body.tags).toEqual(['tag1', 'tag2']);
  });
});
