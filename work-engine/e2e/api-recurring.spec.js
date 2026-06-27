const { test, expect } = require('@playwright/test');

// Helper to clean up configs created during tests
async function deleteConfig(request, id) {
  await request.delete(`/api/recurring/${id}`);
}

// Helper to disable all enabled configs (for isolation in generation tests)
async function disableAllConfigs(request) {
  const res = await request.get('/api/recurring');
  const { recurringConfigs } = await res.json();
  for (const config of recurringConfigs) {
    if (config.enabled) {
      await request.put(`/api/recurring/${config.id}`, {
        data: { enabled: false },
      });
    }
  }
}

test.describe('Recurring Config API', () => {
  // ──────────────────────────────────────────────────────────────────
  // Scenario: Create a recurring config with cronExpression
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring creates config with cronExpression', async ({ request }) => {
    const res = await request.post('/api/recurring', {
      data: {
        description: 'Weekly standup',
        cronExpression: '0 9 * * 3',
      },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.recurringConfig).toBeDefined();
    expect(body.recurringConfig.id).toBeDefined();
    expect(body.recurringConfig.description).toBe('Weekly standup');
    expect(body.recurringConfig.cronExpression).toBe('0 9 * * 3');
    expect(body.recurringConfig.enabled).toBe(true);
    expect(body.recurringConfig.createdAt).toBeDefined();
    expect(body.recurringConfig.updatedAt).toBeDefined();
    // Old fields should NOT be present
    expect(body.recurringConfig.schedule).toBeUndefined();
    expect(body.recurringConfig.dayOfWeek).toBeUndefined();
    expect(body.recurringConfig.dayOfMonth).toBeUndefined();

    // Cleanup
    await deleteConfig(request, body.recurringConfig.id);
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Create a recurring config with assigneeId
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring creates config with assigneeId', async ({ request }) => {
    const res = await request.post('/api/recurring', {
      data: {
        description: 'Mailchimp dump',
        cronExpression: '0 10 * * 3',
        assigneeId: 'user-grace',
      },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.recurringConfig.assigneeId).toBe('user-grace');
    expect(body.recurringConfig.cronExpression).toBe('0 10 * * 3');

    // Cleanup
    await deleteConfig(request, body.recurringConfig.id);
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Reject missing cronExpression on create
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring rejects missing cronExpression', async ({ request }) => {
    const res = await request.post('/api/recurring', {
      data: { description: 'No cron' },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain('cronexpression');
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Reject malformed cronExpression
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring rejects malformed cronExpression', async ({ request }) => {
    const res = await request.post('/api/recurring', {
      data: {
        description: 'Bad cron',
        cronExpression: 'every wednesday',
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain('cron');
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Reject old schedule field
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring rejects old schedule field', async ({ request }) => {
    const res = await request.post('/api/recurring', {
      data: {
        description: 'Old style',
        schedule: 'weekly',
        dayOfWeek: 3,
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain('cronexpression');
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Update a recurring config's cronExpression
  // ──────────────────────────────────────────────────────────────────

  test('PUT /api/recurring/:id updates cronExpression', async ({ request }) => {
    // Create first
    const createRes = await request.post('/api/recurring', {
      data: {
        description: 'Update cron test',
        cronExpression: '0 9 * * 3',
      },
    });
    const { recurringConfig: created } = await createRes.json();

    // Update cronExpression
    const updateRes = await request.put(`/api/recurring/${created.id}`, {
      data: { cronExpression: '0 9 * * 1' },
    });

    expect(updateRes.status()).toBe(200);
    const body = await updateRes.json();
    expect(body.recurringConfig.cronExpression).toBe('0 9 * * 1');

    // Cleanup
    await deleteConfig(request, created.id);
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Update a recurring config's assigneeId
  // ──────────────────────────────────────────────────────────────────

  test('PUT /api/recurring/:id updates assigneeId', async ({ request }) => {
    // Create first
    const createRes = await request.post('/api/recurring', {
      data: {
        description: 'Update assignee test',
        cronExpression: '0 9 * * *',
      },
    });
    const { recurringConfig: created } = await createRes.json();

    // Update assigneeId
    const updateRes = await request.put(`/api/recurring/${created.id}`, {
      data: { assigneeId: 'user-valeriia' },
    });

    expect(updateRes.status()).toBe(200);
    const body = await updateRes.json();
    expect(body.recurringConfig.assigneeId).toBe('user-valeriia');

    // Cleanup
    await deleteConfig(request, created.id);
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Generate daily tasks from cron expression
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring/generate creates daily tasks (cron: 0 9 * * *)', async ({ request }) => {
    await disableAllConfigs(request);

    const createRes = await request.post('/api/recurring', {
      data: {
        description: 'E2E daily standup',
        cronExpression: '0 9 * * *',
      },
    });
    const { recurringConfig: config } = await createRes.json();

    const genRes = await request.post('/api/recurring/generate', {
      data: {
        startDate: '2028-01-02',
        endDate: '2028-01-04',
      },
    });

    expect(genRes.status()).toBe(200);
    const body = await genRes.json();
    expect(body.generated.length).toBe(3);
    expect(body.skipped).toBe(0);

    for (const task of body.generated) {
      expect(task.source).toBe('recurring');
      expect(task.status).toBe('todo');
      expect(task.description).toBe('E2E daily standup');
    }

    // Cleanup
    await request.put(`/api/recurring/${config.id}`, {
      data: { enabled: false },
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Generate weekly tasks from cron expression
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring/generate creates weekly tasks (cron: 0 9 * * 3)', async ({ request }) => {
    await disableAllConfigs(request);

    const createRes = await request.post('/api/recurring', {
      data: {
        description: 'E2E wednesday task',
        cronExpression: '0 9 * * 3',
      },
    });
    const { recurringConfig: config } = await createRes.json();

    const genRes = await request.post('/api/recurring/generate', {
      data: {
        startDate: '2028-02-01',
        endDate: '2028-02-14',
      },
    });

    expect(genRes.status()).toBe(200);
    const body = await genRes.json();
    expect(body.generated.length).toBe(2);
    const dates = body.generated.map((t) => t.date).sort();
    expect(dates).toEqual(['2028-02-02', '2028-02-09']);

    // Cleanup
    await request.put(`/api/recurring/${config.id}`, {
      data: { enabled: false },
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Generate monthly tasks from cron expression
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring/generate creates monthly tasks (cron: 0 9 15 * *)', async ({ request }) => {
    await disableAllConfigs(request);

    const createRes = await request.post('/api/recurring', {
      data: {
        description: 'E2E monthly task',
        cronExpression: '0 9 15 * *',
      },
    });
    const { recurringConfig: config } = await createRes.json();

    const genRes = await request.post('/api/recurring/generate', {
      data: {
        startDate: '2028-06-01',
        endDate: '2028-08-30',
      },
    });

    expect(genRes.status()).toBe(200);
    const body = await genRes.json();
    expect(body.generated.length).toBe(3);
    const dates = body.generated.map((t) => t.date).sort();
    expect(dates).toEqual(['2028-06-15', '2028-07-15', '2028-08-15']);

    // Cleanup
    await request.put(`/api/recurring/${config.id}`, {
      data: { enabled: false },
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Generated tasks inherit assigneeId from config
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring/generate tasks inherit assigneeId', async ({ request }) => {
    await disableAllConfigs(request);

    const createRes = await request.post('/api/recurring', {
      data: {
        description: 'E2E assigned task',
        cronExpression: '0 9 * * *',
        assigneeId: 'user-grace',
      },
    });
    const { recurringConfig: config } = await createRes.json();

    const genRes = await request.post('/api/recurring/generate', {
      data: {
        startDate: '2028-05-01',
        endDate: '2028-05-01',
      },
    });

    expect(genRes.status()).toBe(200);
    const body = await genRes.json();
    expect(body.generated.length).toBe(1);
    expect(body.generated[0].assigneeId).toBe('user-grace');

    // Cleanup
    await request.put(`/api/recurring/${config.id}`, {
      data: { enabled: false },
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scenario: Idempotent generation skips existing tasks
  // ──────────────────────────────────────────────────────────────────

  test('POST /api/recurring/generate is idempotent', async ({ request }) => {
    await disableAllConfigs(request);

    const createRes = await request.post('/api/recurring', {
      data: {
        description: 'E2E idempotent task',
        cronExpression: '0 9 * * *',
      },
    });
    const { recurringConfig: config } = await createRes.json();

    // First call generates tasks
    const genRes1 = await request.post('/api/recurring/generate', {
      data: {
        startDate: '2028-01-10',
        endDate: '2028-01-12',
      },
    });
    const body1 = await genRes1.json();
    expect(body1.generated.length).toBe(3);
    expect(body1.skipped).toBe(0);

    // Second call skips them
    const genRes2 = await request.post('/api/recurring/generate', {
      data: {
        startDate: '2028-01-10',
        endDate: '2028-01-12',
      },
    });
    const body2 = await genRes2.json();
    expect(body2.generated.length).toBe(0);
    expect(body2.skipped).toBe(3);

    // Cleanup
    await request.put(`/api/recurring/${config.id}`, {
      data: { enabled: false },
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Other API tests
  // ──────────────────────────────────────────────────────────────────

  test('GET /api/recurring returns list of configs', async ({ request }) => {
    const res = await request.get('/api/recurring');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/json');

    const body = await res.json();
    expect(body.recurringConfigs).toBeInstanceOf(Array);
  });

  test('GET /api/recurring/:id returns 404 for nonexistent', async ({ request }) => {
    const res = await request.get('/api/recurring/nonexistent-id');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('not found');
  });

  test('DELETE /api/recurring/:id deletes a config', async ({ request }) => {
    // Create
    const createRes = await request.post('/api/recurring', {
      data: {
        description: 'E2E delete me',
        cronExpression: '0 9 * * *',
      },
    });
    const { recurringConfig: config } = await createRes.json();

    // Delete
    const delRes = await request.delete(`/api/recurring/${config.id}`);
    expect(delRes.status()).toBe(204);

    // Verify gone
    const getRes = await request.get(`/api/recurring/${config.id}`);
    expect(getRes.status()).toBe(404);
  });

  test('PATCH /api/recurring returns 405', async ({ request }) => {
    const res = await request.patch('/api/recurring');
    expect(res.status()).toBe(405);
    const body = await res.json();
    expect(body.error).toBe('Method not allowed');
  });
});
