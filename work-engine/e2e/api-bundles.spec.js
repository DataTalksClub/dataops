const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

// Helper: UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Helper: ISO-8601 timestamp pattern
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

// Helper: archive and delete a bundle
async function archiveAndDelete(request, bundleId) {
  await request.put(`/api/bundles/${bundleId}/archive`);
  await request.delete(`/api/bundles/${bundleId}`);
}

test.describe('Bundle CRUD API', () => {
  // ──────────────────────────────────────────────────────────────────
  // POST /api/bundles -- Create
  // ──────────────────────────────────────────────────────────────────

  test.describe('POST /api/bundles', () => {
    test('creates a bundle with required fields only (title + anchorDate)', async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: { title: 'ML Zoomcamp 2026', anchorDate: '2026-06-01' },
      });
      expect(res.status()).toBe(201);

      const body = await res.json();
      expect(body.bundle).toBeDefined();
      expect(body.bundle.id).toMatch(UUID_RE);
      expect(body.bundle.title).toBe('ML Zoomcamp 2026');
      expect(body.bundle.anchorDate).toBe('2026-06-01');
      expect(body.bundle.createdAt).toMatch(ISO_TS_RE);
      expect(body.bundle.updatedAt).toMatch(ISO_TS_RE);

      // No tasks key when no templateId provided
      expect(body.tasks).toBeUndefined();
    });

    test('creates a bundle with optional description', async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: {
          title: 'Newsletter',
          anchorDate: '2026-03-01',
          description: 'Weekly newsletter',
        },
      });
      expect(res.status()).toBe(201);

      const body = await res.json();
      expect(body.bundle.description).toBe('Weekly newsletter');
      expect(body.bundle.title).toBe('Newsletter');
      expect(body.bundle.anchorDate).toBe('2026-03-01');
    });

    test('returns 400 when title is missing', async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: { anchorDate: '2026-06-01' },
      });
      expect(res.status()).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.toLowerCase()).toContain('title');
    });

    test('returns 400 when anchorDate is missing', async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: { title: 'Test' },
      });
      expect(res.status()).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.toLowerCase()).toContain('anchordate');
    });

    test('returns 400 for invalid anchorDate format', async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: { title: 'Bad date', anchorDate: '06-01-2026' },
      });
      expect(res.status()).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    test('returns 400 for empty title string', async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: { title: '   ', anchorDate: '2026-06-01' },
      });
      expect(res.status()).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.toLowerCase()).toContain('title');
    });

    test('returns 201 and Content-Type application/json', async ({ request }) => {
      const res = await request.post('/api/bundles', {
        data: { title: 'Content-Type test', anchorDate: '2026-07-01' },
      });
      expect(res.status()).toBe(201);
      expect(res.headers()['content-type']).toBe('application/json');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/bundles -- List all
  // ──────────────────────────────────────────────────────────────────

  test.describe('GET /api/bundles', () => {
    test('lists all bundles as an array', async ({ request }) => {
      // Ensure at least one bundle exists
      await request.post('/api/bundles', {
        data: { title: 'List test', anchorDate: '2026-07-01' },
      });

      const res = await request.get('/api/bundles');
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.bundles).toBeInstanceOf(Array);
      expect(body.bundles.length).toBeGreaterThan(0);
    });

    test('returns Content-Type application/json', async ({ request }) => {
      const res = await request.get('/api/bundles');
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('application/json');
    });

    test('each bundle in the list has expected fields', async ({ request }) => {
      await request.post('/api/bundles', {
        data: { title: 'Fields check', anchorDate: '2026-08-01' },
      });

      const res = await request.get('/api/bundles');
      const body = await res.json();

      const bundle = body.bundles.find((b) => b.title === 'Fields check');
      expect(bundle).toBeDefined();
      expect(bundle.id).toMatch(UUID_RE);
      expect(bundle.anchorDate).toBe('2026-08-01');
      expect(bundle.createdAt).toBeTruthy();
      expect(bundle.updatedAt).toBeTruthy();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/bundles/:id -- Single bundle
  // ──────────────────────────────────────────────────────────────────

  test.describe('GET /api/bundles/:id', () => {
    test('returns the bundle when it exists', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'Fetch me', anchorDate: '2026-07-01', description: 'desc' },
      });
      const { bundle } = await create.json();

      const res = await request.get(`/api/bundles/${bundle.id}`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.bundle.id).toBe(bundle.id);
      expect(body.bundle.title).toBe('Fetch me');
      expect(body.bundle.description).toBe('desc');
      expect(body.bundle.anchorDate).toBe('2026-07-01');
    });

    test('returns 404 for a non-existent bundle', async ({ request }) => {
      const res = await request.get('/api/bundles/does-not-exist');
      expect(res.status()).toBe(404);

      const body = await res.json();
      expect(body.error).toBe('Bundle not found');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PUT /api/bundles/:id -- Update
  // ──────────────────────────────────────────────────────────────────

  test.describe('PUT /api/bundles/:id', () => {
    test('updates the title of an existing bundle', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'Old Title', anchorDate: '2026-07-01' },
      });
      const { bundle: original } = await create.json();

      const res = await request.put(`/api/bundles/${original.id}`, {
        data: { title: 'New Title' },
      });
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.bundle.title).toBe('New Title');
      expect(body.bundle.id).toBe(original.id);
    });

    test('updates the description', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'Desc bundle', anchorDate: '2026-07-01', description: 'original' },
      });
      const { bundle } = await create.json();

      const res = await request.put(`/api/bundles/${bundle.id}`, {
        data: { description: 'updated description' },
      });
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.bundle.description).toBe('updated description');
    });

    test('updates the anchorDate', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'Date bundle', anchorDate: '2026-07-01' },
      });
      const { bundle } = await create.json();

      const res = await request.put(`/api/bundles/${bundle.id}`, {
        data: { anchorDate: '2026-08-15' },
      });
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.bundle.anchorDate).toBe('2026-08-15');
    });

    test('updatedAt changes after an update', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'Timestamp bundle', anchorDate: '2026-07-01' },
      });
      const { bundle: original } = await create.json();

      // Small delay so timestamps differ
      await new Promise((r) => setTimeout(r, 50));

      const res = await request.put(`/api/bundles/${original.id}`, {
        data: { title: 'Updated timestamp' },
      });
      const { bundle: updated } = await res.json();

      expect(updated.updatedAt).not.toBe(original.updatedAt);
    });

    test('returns 404 for a non-existent bundle', async ({ request }) => {
      const res = await request.put('/api/bundles/does-not-exist', {
        data: { title: 'New' },
      });
      expect(res.status()).toBe(404);

      const body = await res.json();
      expect(body.error).toBe('Bundle not found');
    });

    test('returns 400 when body has no valid fields', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'No valid fields', anchorDate: '2026-07-01' },
      });
      const { bundle } = await create.json();

      const res = await request.put(`/api/bundles/${bundle.id}`, {
        data: { unknownField: 'value' },
      });
      expect(res.status()).toBe(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // DELETE /api/bundles/:id -- Delete
  // ──────────────────────────────────────────────────────────────────

  test.describe('DELETE /api/bundles/:id', () => {
    test('deletes an archived bundle and returns 204', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'Delete me', anchorDate: '2026-07-01' },
      });
      const { bundle } = await create.json();

      // Archive first
      await request.put(`/api/bundles/${bundle.id}/archive`);

      const del = await request.delete(`/api/bundles/${bundle.id}`);
      expect(del.status()).toBe(204);

      // Verify the response body is empty
      const text = await del.text();
      expect(text).toBe('');
    });

    test('deleted bundle is no longer retrievable', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'Delete and verify', anchorDate: '2026-07-01' },
      });
      const { bundle } = await create.json();

      // Archive first, then delete
      await request.put(`/api/bundles/${bundle.id}/archive`);
      await request.delete(`/api/bundles/${bundle.id}`);

      const get = await request.get(`/api/bundles/${bundle.id}`);
      expect(get.status()).toBe(404);
    });

    test('returns 400 when deleting a non-archived bundle', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'Active bundle', anchorDate: '2026-07-01' },
      });
      const { bundle } = await create.json();

      const del = await request.delete(`/api/bundles/${bundle.id}`);
      expect(del.status()).toBe(400);

      const body = await del.json();
      expect(body.error).toBe('Only archived bundles can be deleted');
    });

    test('returns 404 for a non-existent bundle', async ({ request }) => {
      const res = await request.delete('/api/bundles/does-not-exist');
      expect(res.status()).toBe(404);

      const body = await res.json();
      expect(body.error).toBe('Bundle not found');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/bundles/:id/tasks -- Bundle tasks
  // ──────────────────────────────────────────────────────────────────

  test.describe('GET /api/bundles/:id/tasks', () => {
    test('returns an empty tasks array for a bundle with no tasks', async ({ request }) => {
      const create = await request.post('/api/bundles', {
        data: { title: 'No tasks bundle', anchorDate: '2026-07-01' },
      });
      const { bundle } = await create.json();

      const res = await request.get(`/api/bundles/${bundle.id}/tasks`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.tasks).toBeInstanceOf(Array);
      expect(body.tasks).toHaveLength(0);
    });

    test('returns tasks that belong to the bundle', async ({ request }) => {
      // Create a template with 2 tasks
      const tmplRes = await request.post('/api/templates', {
        data: {
          name: 'Tasks test', type: 'test',
          taskDefinitions: [
            { refId: 'a1', description: 'Task A', offsetDays: 0 },
            { refId: 'a2', description: 'Task B', offsetDays: 1 },
          ],
        },
      });
      const { template } = await tmplRes.json();

      // Create bundle with that template to generate tasks
      const create = await request.post('/api/bundles', {
        data: { title: 'Has tasks', anchorDate: '2026-05-01', templateId: template.id },
      });
      const { bundle } = await create.json();

      const res = await request.get(`/api/bundles/${bundle.id}/tasks`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
      expect(body.tasks.every((t) => t.bundleId === bundle.id)).toBe(true);
    });

    test('returns 404 for a non-existent bundle', async ({ request }) => {
      const res = await request.get('/api/bundles/does-not-exist/tasks');
      expect(res.status()).toBe(404);

      const body = await res.json();
      expect(body.error).toBe('Bundle not found');
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Bundle with template
// ──────────────────────────────────────────────────────────────────

test.describe('Bundle with template', () => {
  test('creates bundle from template and generates tasks with correct dates', async ({ request }) => {
    // Create template with offsets -7, 0, +3
    const tmplRes = await request.post('/api/templates', {
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

    // Create bundle with anchorDate 2026-04-15
    const res = await request.post('/api/bundles', {
      data: {
        title: 'Community Meetup',
        anchorDate: '2026-04-15',
        templateId: template.id,
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();

    // Verify bundle
    expect(body.bundle).toBeDefined();
    expect(body.bundle.id).toMatch(UUID_RE);
    expect(body.bundle.title).toBe('Community Meetup');
    expect(body.bundle.templateId).toBe(template.id);

    // Verify tasks array is returned
    expect(body.tasks).toBeDefined();
    expect(body.tasks).toHaveLength(3);

    // Verify task dates: anchor 2026-04-15 with offsets -7, 0, +3
    const dates = body.tasks.map((t) => t.date).sort();
    expect(dates).toEqual(['2026-04-08', '2026-04-15', '2026-04-18']);
  });

  test('template tasks have source "template" and correct bundleId', async ({ request }) => {
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'Source check template', type: 'test',
        taskDefinitions: [
          { refId: 's1', description: 'Task 1', offsetDays: 0 },
          { refId: 's2', description: 'Task 2', offsetDays: 5 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    const res = await request.post('/api/bundles', {
      data: {
        title: 'Source check bundle',
        anchorDate: '2026-05-01',
        templateId: template.id,
      },
    });
    const body = await res.json();

    expect(body.tasks).toHaveLength(2);
    for (const task of body.tasks) {
      expect(task.source).toBe('template');
      expect(task.bundleId).toBe(body.bundle.id);
    }
  });

  test('template tasks are retrievable via GET /api/bundles/:id/tasks', async ({ request }) => {
    const tmplRes = await request.post('/api/templates', {
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

    const createRes = await request.post('/api/bundles', {
      data: {
        title: 'Conference',
        anchorDate: '2026-04-15',
        templateId: template.id,
      },
    });
    const { bundle, tasks: createdTasks } = await createRes.json();

    // Verify via the sub-route
    const tasksRes = await request.get(`/api/bundles/${bundle.id}/tasks`);
    expect(tasksRes.status()).toBe(200);

    const tasksBody = await tasksRes.json();
    expect(tasksBody.tasks).toHaveLength(3);
    expect(tasksBody.tasks.every((t) => t.source === 'template')).toBe(true);
    expect(tasksBody.tasks.every((t) => t.bundleId === bundle.id)).toBe(true);

    // Verify dates match what was returned at creation
    const fetchedDates = tasksBody.tasks.map((t) => t.date).sort();
    const createdDates = createdTasks.map((t) => t.date).sort();
    expect(fetchedDates).toEqual(createdDates);
  });

  test('template tasks have correct templateTaskRef from refId', async ({ request }) => {
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'RefId template', type: 'test',
        taskDefinitions: [
          { refId: 'ref-alpha', description: 'Alpha task', offsetDays: -3 },
          { refId: 'ref-beta', description: 'Beta task', offsetDays: 0 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    const res = await request.post('/api/bundles', {
      data: {
        title: 'RefId bundle',
        anchorDate: '2026-06-10',
        templateId: template.id,
      },
    });
    const body = await res.json();

    const refs = body.tasks.map((t) => t.templateTaskRef).sort();
    expect(refs).toEqual(['ref-alpha', 'ref-beta']);
  });

  test('returns 404 when templateId does not exist', async ({ request }) => {
    const res = await request.post('/api/bundles', {
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

  test('no bundle is created when templateId does not exist', async ({ request }) => {
    // Attempt to create with bad template
    const rejectedTitle = 'Should not exist from bad template';
    await request.post('/api/bundles', {
      data: {
        title: rejectedTitle,
        anchorDate: '2026-01-01',
        templateId: 'nonexistent-template-id',
      },
    });

    // Verify the rejected payload was not persisted. Other E2E specs share the
    // same test server and may create/delete unrelated bundles in parallel.
    const after = await request.get('/api/bundles');
    const afterBody = await after.json();
    expect(afterBody.bundles.some((bundle) => bundle.title === rejectedTitle)).toBe(false);
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
// Tasks filtered by bundleId
// ──────────────────────────────────────────────────────────────────

test.describe('Tasks filtered by bundleId', () => {
  test('GET /api/tasks?bundleId returns tasks for that bundle', async ({ request }) => {
    // Create a bundle with template tasks
    const tmplRes = await request.post('/api/templates', {
      data: {
        name: 'Filter test template', type: 'test',
        taskDefinitions: [
          { refId: 'f1', description: 'Filter task 1', offsetDays: 0 },
          { refId: 'f2', description: 'Filter task 2', offsetDays: 1 },
        ],
      },
    });
    const { template } = await tmplRes.json();

    const createRes = await request.post('/api/bundles', {
      data: {
        title: 'Filter bundle',
        anchorDate: '2026-09-01',
        templateId: template.id,
      },
    });
    const { bundle } = await createRes.json();

    const res = await request.get(`/api/tasks?bundleId=${bundle.id}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.tasks.length).toBe(2);
    for (const task of body.tasks) {
      expect(task.bundleId).toBe(bundle.id);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Frontend navigation
// ──────────────────────────────────────────────────────────────────

test.describe('Frontend bundles page', () => {
  test('navigating to #/bundles shows Bundles heading and New Bundle form', async ({ page }) => {
    await page.goto('/#/bundles');
    await page.waitForSelector('h2');

    const heading = await page.textContent('h2');
    expect(heading).toBe('Bundles');

    const formHeading = await page.textContent('.form-section h3');
    expect(formHeading).toBe('New Bundle');

    // Verify the form fields are present
    await expect(page.locator('#bundle-title')).toBeVisible();
    await expect(page.locator('#bundle-anchor')).toBeVisible();
    await expect(page.locator('#bundle-create-btn')).toBeVisible();
  });

  test('nav bar shows Bundles link (not Projects)', async ({ page }) => {
    await page.goto('/');
    // Wait for page to load
    await page.waitForSelector('nav');

    const navText = await page.textContent('nav');
    expect(navText).toContain('Bundles');
    expect(navText).not.toContain('Projects');

    // Verify the link href
    const bundleLink = page.locator('nav a[href="#/bundles"]');
    await expect(bundleLink).toBeVisible();
  });

  test('empty state explains how to create the first bundle', async ({ page }) => {
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

    await page.goto('/#/bundles');
    await page.waitForSelector('.empty-state');

    await expect(page.locator('.empty-state-title')).toHaveText('No bundles yet');
    await expect(page.locator('.empty-state-body')).toContainText('Use the form above to create a bundle');
  });

  test('creating a bundle from the frontend form works', async ({ page }) => {
    const title = `Frontend Bundle ${Date.now()}`;

    await page.goto('/#/bundles');
    await page.waitForSelector('#bundle-title');

    await page.fill('#bundle-title', title);
    await page.fill('#bundle-anchor', '2026-07-01');
    await page.click('#bundle-create-btn');

    const card = page.locator('.bundle-card').filter({
      has: page.locator('.bundle-card-title', { hasText: title }),
    });
    await expect(card).toBeVisible();
    await expect(card.locator('.card-action-link')).toHaveText('Open bundle');
    await expect(card.locator('.card-action-link')).toHaveAttribute('href', '#/bundles');
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
// Bundle data model: new fields, stage, archive, delete guard
// (Tests for issue #18)
// ──────────────────────────────────────────────────────────────────

test.describe('Bundle data model updates (issue #18)', () => {

  // Scenario: Create a bundle with all new fields
  test('creates a bundle with all new fields (emoji, tags, references, bundleLinks)', async ({ request }) => {
    const res = await request.post('/api/bundles', {
      data: {
        title: 'Newsletter Mar 2026',
        anchorDate: '2026-03-15',
        emoji: '📰',
        tags: ['newsletter'],
        references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
        bundleLinks: [{ name: 'Luma', url: '' }],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.bundle.emoji).toBe('📰');
    expect(body.bundle.tags).toEqual(['newsletter']);
    expect(body.bundle.references).toEqual([{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
    expect(body.bundle.bundleLinks).toEqual([{ name: 'Luma', url: '' }]);
    expect(body.bundle.stage).toBe('preparation');
    expect(body.bundle.status).toBe('active');
  });

  // Scenario: Create a bundle with only required fields (backward compatibility)
  test('creates a bundle with only required fields -- defaults stage and status', async ({ request }) => {
    const res = await request.post('/api/bundles', {
      data: { title: 'Simple Bundle', anchorDate: '2026-04-01' },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.bundle.stage).toBe('preparation');
    expect(body.bundle.status).toBe('active');
    expect(body.bundle.emoji).toBeUndefined();
    expect(body.bundle.tags).toBeUndefined();
    expect(body.bundle.references).toBeUndefined();
    expect(body.bundle.bundleLinks).toBeUndefined();
  });

  // Scenario: Update a bundle stage
  test('updates a bundle stage from preparation to announced', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Stage test', anchorDate: '2026-05-01' },
    });
    const { bundle } = await create.json();
    expect(bundle.stage).toBe('preparation');

    const res = await request.put(`/api/bundles/${bundle.id}`, {
      data: { stage: 'announced' },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.bundle.stage).toBe('announced');
  });

  // Scenario: Reject invalid stage value
  test('rejects invalid stage value with 400', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Invalid stage', anchorDate: '2026-05-01' },
    });
    const { bundle } = await create.json();

    const res = await request.put(`/api/bundles/${bundle.id}`, {
      data: { stage: 'invalid-stage' },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid stage');
  });

  // Scenario: Reject invalid status value
  test('rejects invalid status value with 400', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Invalid status', anchorDate: '2026-05-01' },
    });
    const { bundle } = await create.json();

    const res = await request.put(`/api/bundles/${bundle.id}`, {
      data: { status: 'invalid-status' },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid status');
  });

  // Scenario: Update bundle with references and bundleLinks
  test('updates bundle with references and bundleLinks', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Links update', anchorDate: '2026-05-01' },
    });
    const { bundle } = await create.json();

    const res = await request.put(`/api/bundles/${bundle.id}`, {
      data: {
        references: [{ name: 'Process doc', url: 'https://docs.google.com/proc' }],
        bundleLinks: [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }],
      },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.bundle.references).toEqual([{ name: 'Process doc', url: 'https://docs.google.com/proc' }]);
    expect(body.bundle.bundleLinks).toEqual([{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }]);
  });

  // Scenario: Archive a bundle via the archive endpoint
  test('archives a bundle via PUT /api/bundles/:id/archive', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Archive me', anchorDate: '2026-05-01' },
    });
    const { bundle } = await create.json();
    expect(bundle.status).toBe('active');

    const res = await request.put(`/api/bundles/${bundle.id}/archive`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.bundle.status).toBe('archived');
    expect(body.bundle.id).toBe(bundle.id);
  });

  // Scenario: Archive returns 404 for non-existent bundle
  test('archive returns 404 for non-existent bundle', async ({ request }) => {
    const res = await request.put('/api/bundles/does-not-exist/archive');
    expect(res.status()).toBe(404);
  });

  // Scenario: Delete a non-archived bundle is rejected
  test('delete of non-archived bundle returns 400', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Cannot delete active', anchorDate: '2026-05-01' },
    });
    const { bundle } = await create.json();

    const res = await request.delete(`/api/bundles/${bundle.id}`);
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBe('Only archived bundles can be deleted');
  });

  // Scenario: Delete an archived bundle succeeds
  test('delete of archived bundle returns 204', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Archive then delete', anchorDate: '2026-05-01' },
    });
    const { bundle } = await create.json();

    // Archive first
    await request.put(`/api/bundles/${bundle.id}/archive`);

    const del = await request.delete(`/api/bundles/${bundle.id}`);
    expect(del.status()).toBe(204);

    // Verify gone
    const get = await request.get(`/api/bundles/${bundle.id}`);
    expect(get.status()).toBe(404);
  });

  // Scenario: Retrieve a bundle with new fields via GET
  test('GET returns all new fields that were set on creation', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: {
        title: 'Full GET test',
        anchorDate: '2026-06-01',
        emoji: '🎙️',
        tags: ['podcast', 'weekly'],
        references: [{ name: 'Docs', url: 'https://example.com/docs' }],
        bundleLinks: [{ name: 'YouTube', url: 'https://youtube.com/x' }],
      },
    });
    const { bundle } = await create.json();

    const res = await request.get(`/api/bundles/${bundle.id}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.bundle.emoji).toBe('🎙️');
    expect(body.bundle.tags).toEqual(['podcast', 'weekly']);
    expect(body.bundle.references).toEqual([{ name: 'Docs', url: 'https://example.com/docs' }]);
    expect(body.bundle.bundleLinks).toEqual([{ name: 'YouTube', url: 'https://youtube.com/x' }]);
    expect(body.bundle.stage).toBe('preparation');
    expect(body.bundle.status).toBe('active');
  });

  // Scenario: Existing bundle without new fields still works
  test('bundle without new fields still returns correctly', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Minimal bundle', anchorDate: '2026-01-01' },
    });
    const { bundle } = await create.json();

    const res = await request.get(`/api/bundles/${bundle.id}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.bundle.title).toBe('Minimal bundle');
    // New optional fields are not present
    expect(body.bundle.emoji).toBeUndefined();
    expect(body.bundle.tags).toBeUndefined();
    expect(body.bundle.references).toBeUndefined();
    expect(body.bundle.bundleLinks).toBeUndefined();
  });

  // Test all valid stages
  test('can cycle through all valid stages', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Stage cycle', anchorDate: '2026-06-01' },
    });
    const { bundle } = await create.json();

    const stages = ['announced', 'after-event', 'done'];
    for (const stage of stages) {
      const res = await request.put(`/api/bundles/${bundle.id}`, {
        data: { stage },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.bundle.stage).toBe(stage);
    }
  });

  // Test updating emoji and tags
  test('updates emoji and tags via PUT', async ({ request }) => {
    const create = await request.post('/api/bundles', {
      data: { title: 'Emoji tags update', anchorDate: '2026-06-01' },
    });
    const { bundle } = await create.json();

    const res = await request.put(`/api/bundles/${bundle.id}`, {
      data: { emoji: '📰', tags: ['newsletter', 'weekly'] },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.bundle.emoji).toBe('📰');
    expect(body.bundle.tags).toEqual(['newsletter', 'weekly']);
  });
});
