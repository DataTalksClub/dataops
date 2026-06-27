const { test, expect } = require('@playwright/test');

// Helper: UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('Template API - New fields (issue #17)', () => {
  // Scenario: Create a template with all new fields
  test('POST creates template with all new template-level fields', async ({ request }) => {
    const res = await request.post('/api/templates', {
      data: {
        name: 'Newsletter Weekly',
        type: 'newsletter',
        emoji: '\u{1F4F0}',
        tags: ['newsletter'],
        defaultAssigneeId: 'user-grace',
        references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
        bundleLinkDefinitions: [{ name: 'Luma' }, { name: 'YouTube' }],
        triggerType: 'automatic',
        triggerSchedule: '0 9 * * 1',
        triggerLeadDays: 14,
        taskDefinitions: [
          { refId: 'draft', description: 'Write draft', offsetDays: -7 },
          { refId: 'send', description: 'Send newsletter', offsetDays: 0 },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    const t = body.template;
    expect(t.id).toMatch(UUID_RE);
    expect(t.name).toBe('Newsletter Weekly');
    expect(t.type).toBe('newsletter');
    expect(t.emoji).toBe('\u{1F4F0}');
    expect(t.tags).toEqual(['newsletter']);
    expect(t.defaultAssigneeId).toBe('user-grace');
    expect(t.references).toEqual([{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
    expect(t.bundleLinkDefinitions).toEqual([{ name: 'Luma' }, { name: 'YouTube' }]);
    expect(t.triggerType).toBe('automatic');
    expect(t.triggerSchedule).toBe('0 9 * * 1');
    expect(t.triggerLeadDays).toBe(14);
  });

  // Scenario: Create a template with only required fields (backward compatibility)
  test('POST creates template with only required fields (backward compat)', async ({ request }) => {
    const res = await request.post('/api/templates', {
      data: {
        name: 'Minimal',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    const t = body.template;
    expect(t.name).toBe('Minimal');
    expect(t.type).toBe('test');
    // Optional fields should be absent
    expect(t.emoji).toBeUndefined();
    expect(t.tags).toBeUndefined();
    expect(t.defaultAssigneeId).toBeUndefined();
    expect(t.references).toBeUndefined();
    expect(t.bundleLinkDefinitions).toBeUndefined();
    expect(t.triggerType).toBeUndefined();
    expect(t.triggerSchedule).toBeUndefined();
    expect(t.triggerLeadDays).toBeUndefined();
  });

  // Scenario: Create a template with enriched task definitions
  test('POST creates template with enriched task definitions', async ({ request }) => {
    const res = await request.post('/api/templates', {
      data: {
        name: 'Webinar',
        type: 'webinar',
        taskDefinitions: [
          {
            refId: 'announce',
            description: 'Announce event',
            offsetDays: -7,
            isMilestone: false,
            assigneeId: 'user-valeriia',
            instructionsUrl: 'https://docs.google.com/announce',
            requiredLinkName: 'Luma',
          },
          {
            refId: 'stream',
            description: 'Actual stream',
            offsetDays: 0,
            isMilestone: true,
            stageOnComplete: 'after-event',
            requiresFile: true,
          },
        ],
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    const tds = body.template.taskDefinitions;
    expect(tds).toHaveLength(2);

    expect(tds[0].isMilestone).toBe(false);
    expect(tds[0].assigneeId).toBe('user-valeriia');
    expect(tds[0].instructionsUrl).toBe('https://docs.google.com/announce');
    expect(tds[0].requiredLinkName).toBe('Luma');

    expect(tds[1].isMilestone).toBe(true);
    expect(tds[1].stageOnComplete).toBe('after-event');
    expect(tds[1].requiresFile).toBe(true);
  });

  // Scenario: Reject invalid stageOnComplete value
  test('POST rejects invalid stageOnComplete value', async ({ request }) => {
    const res = await request.post('/api/templates', {
      data: {
        name: 'Bad Stage',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0, stageOnComplete: 'invalid-stage' },
        ],
      },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('stageOnComplete');
  });

  // Scenario: Reject non-boolean isMilestone value
  test('POST rejects non-boolean isMilestone value', async ({ request }) => {
    const res = await request.post('/api/templates', {
      data: {
        name: 'Bad Milestone',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0, isMilestone: 'yes' },
        ],
      },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('isMilestone');
    expect(body.error).toContain('boolean');
  });

  // Scenario: Reject non-boolean requiresFile value
  test('POST rejects non-boolean requiresFile value', async ({ request }) => {
    const res = await request.post('/api/templates', {
      data: {
        name: 'Bad RequiresFile',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0, requiresFile: 1 },
        ],
      },
    });
    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('requiresFile');
    expect(body.error).toContain('boolean');
  });

  // Scenario: Update a template to add emoji, tags, and references
  test('PUT updates template to add emoji, tags, and references', async ({ request }) => {
    // Create a minimal template first
    const createRes = await request.post('/api/templates', {
      data: {
        name: 'Update Target',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      },
    });
    const { template } = await createRes.json();

    const res = await request.put(`/api/templates/${template.id}`, {
      data: {
        emoji: '\u{1F399}\u{FE0F}',
        tags: ['podcast', 'content'],
        references: [{ name: 'Recording guide', url: 'https://docs.google.com/rec' }],
      },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.template.emoji).toBe('\u{1F399}\u{FE0F}');
    expect(body.template.tags).toEqual(['podcast', 'content']);
    expect(body.template.references).toEqual([{ name: 'Recording guide', url: 'https://docs.google.com/rec' }]);
  });

  // Scenario: Update a template to add trigger configuration
  test('PUT updates template to add trigger configuration', async ({ request }) => {
    const createRes = await request.post('/api/templates', {
      data: {
        name: 'Trigger Update',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      },
    });
    const { template } = await createRes.json();

    const res = await request.put(`/api/templates/${template.id}`, {
      data: {
        triggerType: 'automatic',
        triggerSchedule: '0 9 * * 1',
        triggerLeadDays: 14,
      },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.template.triggerType).toBe('automatic');
    expect(body.template.triggerSchedule).toBe('0 9 * * 1');
    expect(body.template.triggerLeadDays).toBe(14);
  });

  // Scenario: Update task definitions with new fields
  test('PUT updates task definitions with new fields', async ({ request }) => {
    const createRes = await request.post('/api/templates', {
      data: {
        name: 'Update Tasks',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      },
    });
    const { template } = await createRes.json();

    const res = await request.put(`/api/templates/${template.id}`, {
      data: {
        taskDefinitions: [
          {
            refId: 'milestone',
            description: 'Milestone task',
            offsetDays: 0,
            isMilestone: true,
            stageOnComplete: 'after-event',
            requiresFile: true,
          },
        ],
      },
    });
    expect(res.status()).toBe(200);

    const body = await res.json();
    const td = body.template.taskDefinitions[0];
    expect(td.isMilestone).toBe(true);
    expect(td.stageOnComplete).toBe('after-event');
    expect(td.requiresFile).toBe(true);
  });

  // Scenario: Retrieve a template with new fields via GET
  test('GET returns all new fields for a template', async ({ request }) => {
    // Create a full template
    const createRes = await request.post('/api/templates', {
      data: {
        name: 'Full Get Test',
        type: 'newsletter',
        emoji: '\u{1F4F0}',
        tags: ['weekly'],
        defaultAssigneeId: 'user-grace',
        references: [{ name: 'Guide', url: 'https://example.com' }],
        bundleLinkDefinitions: [{ name: 'Luma' }],
        triggerType: 'automatic',
        triggerSchedule: '0 9 * * 1',
        triggerLeadDays: 7,
        taskDefinitions: [
          {
            refId: 'task1',
            description: 'Do stuff',
            offsetDays: 0,
            isMilestone: true,
            stageOnComplete: 'done',
            assigneeId: 'user-valeriia',
            requiresFile: false,
            requiredLinkName: 'Luma',
          },
        ],
      },
    });
    const { template } = await createRes.json();

    const res = await request.get(`/api/templates/${template.id}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    const t = body.template;
    expect(t.emoji).toBe('\u{1F4F0}');
    expect(t.tags).toEqual(['weekly']);
    expect(t.defaultAssigneeId).toBe('user-grace');
    expect(t.references).toEqual([{ name: 'Guide', url: 'https://example.com' }]);
    expect(t.bundleLinkDefinitions).toEqual([{ name: 'Luma' }]);
    expect(t.triggerType).toBe('automatic');
    expect(t.triggerSchedule).toBe('0 9 * * 1');
    expect(t.triggerLeadDays).toBe(7);

    const td = t.taskDefinitions[0];
    expect(td.isMilestone).toBe(true);
    expect(td.stageOnComplete).toBe('done');
    expect(td.assigneeId).toBe('user-valeriia');
    expect(td.requiresFile).toBe(false);
    expect(td.requiredLinkName).toBe('Luma');
  });

  // Scenario: Existing template without new fields still works
  test('GET returns template without new fields (backward compat)', async ({ request }) => {
    const createRes = await request.post('/api/templates', {
      data: {
        name: 'Old Style',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      },
    });
    const { template } = await createRes.json();

    const res = await request.get(`/api/templates/${template.id}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    const t = body.template;
    expect(t.name).toBe('Old Style');
    expect(t.type).toBe('test');
    expect(t.emoji).toBeUndefined();
    expect(t.tags).toBeUndefined();
    expect(t.defaultAssigneeId).toBeUndefined();
  });
});
