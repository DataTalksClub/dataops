import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createTemplate } from '../src/db/templates';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
  };
  return handler(event, {});
}

describe('API — Templates', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  // ---- Existing routes still work ----

  describe('Existing routes still work', () => {
    it('GET / returns 200 with HTML', async () => {
      const res = await invoke('GET', '/');
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers!['Content-Type'].includes('text/html'));
    });

    it('GET /api/health returns 200 with ok status', async () => {
      const res = await invoke('GET', '/api/health');
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body, { status: 'ok' });
    });

    it('GET /api/bundles returns 200', async () => {
      const res = await invoke('GET', '/api/bundles');
      assert.strictEqual(res.statusCode, 200);
    });

    it('GET /api/tasks?status=todo returns 200', async () => {
      const event = {
        httpMethod: 'GET',
        path: '/api/tasks',
        body: null,
        queryStringParameters: { status: 'todo' },
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 200);
    });
  });

  // ---- POST /api/templates ----

  describe('POST /api/templates', () => {
    it('creates a template with valid name, type, and taskDefinitions', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Newsletter',
        type: 'newsletter',
        taskDefinitions: [
          { refId: 'draft', description: 'Write draft', offsetDays: -7 },
          { refId: 'send', description: 'Send newsletter', offsetDays: 0 },
        ],
      });

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.headers!['Content-Type'], 'application/json');

      const body = JSON.parse(res.body);
      assert.ok(body.template);
      assert.ok(body.template.id);
      assert.strictEqual(body.template.name, 'Newsletter');
      assert.strictEqual(body.template.type, 'newsletter');
      assert.ok(Array.isArray(body.template.taskDefinitions));
      assert.strictEqual(body.template.taskDefinitions.length, 2);
      assert.ok(body.template.createdAt);
      assert.ok(body.template.updatedAt);
    });

    it('returns 400 when name is missing', async () => {
      const res = await invoke('POST', '/api/templates', {
        type: 'newsletter',
        taskDefinitions: [
          { refId: 'draft', description: 'Write draft', offsetDays: -7 },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('name'));
    });

    it('returns 400 when name is empty string', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: '  ',
        type: 'newsletter',
        taskDefinitions: [
          { refId: 'draft', description: 'Write draft', offsetDays: -7 },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('name'));
    });

    it('returns 400 when type is missing', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Newsletter',
        taskDefinitions: [
          { refId: 'draft', description: 'Write draft', offsetDays: -7 },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('type'));
    });

    it('returns 400 when type is empty string', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Newsletter',
        type: '',
        taskDefinitions: [
          { refId: 'draft', description: 'Write draft', offsetDays: -7 },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('type'));
    });

    it('returns 400 when taskDefinitions is missing', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Newsletter',
        type: 'newsletter',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('taskdefinitions'));
    });

    it('returns 400 when taskDefinitions is empty array', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Newsletter',
        type: 'newsletter',
        taskDefinitions: [],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('taskdefinitions'));
    });

    it('returns 400 when taskDefinitions is not an array', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Newsletter',
        type: 'newsletter',
        taskDefinitions: 'not-an-array',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('taskdefinitions'));
    });

    it('returns 400 when taskDefinition is missing refId', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Test',
        type: 'test',
        taskDefinitions: [
          { description: 'Task without refId', offsetDays: 0 },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('refid'));
    });

    it('returns 400 when taskDefinition is missing description', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Test',
        type: 'test',
        taskDefinitions: [
          { refId: 'task1', offsetDays: 0 },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('description'));
    });

    it('returns 400 when taskDefinition is missing offsetDays', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Test',
        type: 'test',
        taskDefinitions: [
          { refId: 'task1', description: 'Some task' },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('offsetdays'));
    });

    it('returns 400 for malformed JSON body', async () => {
      const res = await invoke('POST', '/api/templates', 'not valid json{{');

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Invalid JSON');
    });
  });

  // ---- GET /api/templates ----

  describe('GET /api/templates', () => {
    it('returns 200 with an array of templates', async () => {
      const res = await invoke('GET', '/api/templates');

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers!['Content-Type'], 'application/json');

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.templates));
      assert.ok(body.templates.length > 0);
    });
  });

  // ---- GET /api/templates/:id ----

  describe('GET /api/templates/:id', () => {
    it('returns 200 with the template for a valid id', async () => {
      const created = await createTemplate(client, {
        name: 'My Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('GET', `/api/templates/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(body.template);
      assert.strictEqual(body.template.id, created.id);
      assert.strictEqual(body.template.name, 'My Template');
      assert.ok(Array.isArray(body.template.taskDefinitions));
    });

    it('returns 404 for a non-existent template', async () => {
      const res = await invoke('GET', '/api/templates/does-not-exist');

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Template not found');
    });
  });

  // ---- PUT /api/templates/:id ----

  describe('PUT /api/templates/:id', () => {
    it('updates a template name and returns 200', async () => {
      const created = await createTemplate(client, {
        name: 'Old Name',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      await new Promise((r) => setTimeout(r, 10));

      const res = await invoke('PUT', `/api/templates/${created.id}`, {
        name: 'New Name',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.template.name, 'New Name');
      assert.ok(body.template.updatedAt > created.updatedAt);
    });

    it('updates a template type and returns 200', async () => {
      const created = await createTemplate(client, {
        name: 'Template',
        type: 'old-type',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, {
        type: 'new-type',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.template.type, 'new-type');
    });

    it('updates taskDefinitions and returns 200', async () => {
      const created = await createTemplate(client, {
        name: 'Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
          { refId: 'b', description: 'Task B', offsetDays: 1 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, {
        taskDefinitions: [
          { refId: 'x', description: 'Task X', offsetDays: -5 },
          { refId: 'y', description: 'Task Y', offsetDays: 0 },
          { refId: 'z', description: 'Task Z', offsetDays: 3 },
        ],
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.template.taskDefinitions.length, 3);
    });

    it('returns 400 when updating taskDefinitions with invalid data', async () => {
      const created = await createTemplate(client, {
        name: 'Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, {
        taskDefinitions: [{ refId: 'a' }],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('description'));
    });

    it('returns 404 when updating a non-existent template', async () => {
      const res = await invoke('PUT', '/api/templates/does-not-exist', {
        name: 'New',
      });

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Template not found');
    });

    it('returns 400 when body is empty', async () => {
      const created = await createTemplate(client, {
        name: 'Test',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, {});

      assert.strictEqual(res.statusCode, 400);
    });

    it('returns 400 when body has no valid fields', async () => {
      const created = await createTemplate(client, {
        name: 'Test',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, {
        unknownField: 'value',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('no valid fields'));
    });

    it('returns 400 for malformed JSON', async () => {
      const created = await createTemplate(client, {
        name: 'Test',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, 'bad json');
      assert.strictEqual(res.statusCode, 400);
    });
  });

  // ---- DELETE /api/templates/:id ----

  describe('DELETE /api/templates/:id', () => {
    it('deletes an existing template and returns 204', async () => {
      const created = await createTemplate(client, {
        name: 'Delete me',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('DELETE', `/api/templates/${created.id}`);
      assert.strictEqual(res.statusCode, 204);

      const getRes = await invoke('GET', `/api/templates/${created.id}`);
      assert.strictEqual(getRes.statusCode, 404);
    });

    it('returns 404 when deleting a non-existent template', async () => {
      const res = await invoke('DELETE', '/api/templates/does-not-exist');
      assert.strictEqual(res.statusCode, 404);
    });
  });

  // ---- Method not allowed ----

  describe('Method not allowed', () => {
    it('returns 405 for PATCH /api/templates', async () => {
      const res = await invoke('PATCH', '/api/templates');
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });

    it('returns 405 for POST /api/templates/:id', async () => {
      const created = await createTemplate(client, {
        name: 'Test',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });
      const res = await invoke('POST', `/api/templates/${created.id}`);
      assert.strictEqual(res.statusCode, 405);
    });

    it('returns 405 for PATCH /api/templates/:id', async () => {
      const created = await createTemplate(client, {
        name: 'Test',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });
      const res = await invoke('PATCH', `/api/templates/${created.id}`);
      assert.strictEqual(res.statusCode, 405);
    });
  });

  // ---- New fields (issue #17) ----

  describe('POST /api/templates with new fields', () => {
    it('creates a template with all new template-level fields', async () => {
      const res = await invoke('POST', '/api/templates', {
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
        ],
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      const t = body.template;
      assert.strictEqual(t.emoji, '\u{1F4F0}');
      assert.deepStrictEqual(t.tags, ['newsletter']);
      assert.strictEqual(t.defaultAssigneeId, 'user-grace');
      assert.deepStrictEqual(t.references, [{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
      assert.deepStrictEqual(t.bundleLinkDefinitions, [{ name: 'Luma' }, { name: 'YouTube' }]);
      assert.strictEqual(t.triggerType, 'automatic');
      assert.strictEqual(t.triggerSchedule, '0 9 * * 1');
      assert.strictEqual(t.triggerLeadDays, 14);
    });

    it('creates a template with only required fields (backward compatibility)', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Minimal Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      const t = body.template;
      assert.strictEqual(t.name, 'Minimal Template');
      assert.strictEqual(t.type, 'test');
      // Optional fields should be absent
      assert.strictEqual(t.emoji, undefined);
      assert.strictEqual(t.tags, undefined);
      assert.strictEqual(t.defaultAssigneeId, undefined);
      assert.strictEqual(t.references, undefined);
      assert.strictEqual(t.bundleLinkDefinitions, undefined);
      assert.strictEqual(t.triggerType, undefined);
      assert.strictEqual(t.triggerSchedule, undefined);
      assert.strictEqual(t.triggerLeadDays, undefined);
    });

    it('creates a template with enriched task definitions', async () => {
      const res = await invoke('POST', '/api/templates', {
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
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      const tds = body.template.taskDefinitions;
      assert.strictEqual(tds.length, 2);

      assert.strictEqual(tds[0].isMilestone, false);
      assert.strictEqual(tds[0].assigneeId, 'user-valeriia');
      assert.strictEqual(tds[0].instructionsUrl, 'https://docs.google.com/announce');
      assert.strictEqual(tds[0].requiredLinkName, 'Luma');

      assert.strictEqual(tds[1].isMilestone, true);
      assert.strictEqual(tds[1].stageOnComplete, 'after-event');
      assert.strictEqual(tds[1].requiresFile, true);
    });

    it('rejects invalid stageOnComplete value', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Bad Stage',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0, stageOnComplete: 'invalid-stage' },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('stageOnComplete'));
    });

    it('rejects non-boolean isMilestone value', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Bad Milestone',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0, isMilestone: 'yes' },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('isMilestone'));
      assert.ok(body.error.includes('boolean'));
    });

    it('rejects non-boolean requiresFile value', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Bad RequiresFile',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0, requiresFile: 'yes' },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('requiresFile'));
      assert.ok(body.error.includes('boolean'));
    });

    it('rejects non-string assigneeId in task definition', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Bad AssigneeId',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0, assigneeId: 123 },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('assigneeId'));
    });

    it('rejects non-string requiredLinkName in task definition', async () => {
      const res = await invoke('POST', '/api/templates', {
        name: 'Bad RequiredLinkName',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0, requiredLinkName: 42 },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('requiredLinkName'));
    });
  });

  describe('PUT /api/templates/:id with new fields', () => {
    it('updates emoji, tags, and references', async () => {
      const created = await createTemplate(client, {
        name: 'Basic Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, {
        emoji: '\u{1F399}\u{FE0F}',
        tags: ['podcast', 'content'],
        references: [{ name: 'Recording guide', url: 'https://docs.google.com/rec' }],
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.template.emoji, '\u{1F399}\u{FE0F}');
      assert.deepStrictEqual(body.template.tags, ['podcast', 'content']);
      assert.deepStrictEqual(body.template.references, [{ name: 'Recording guide', url: 'https://docs.google.com/rec' }]);
    });

    it('updates trigger configuration', async () => {
      const created = await createTemplate(client, {
        name: 'No Trigger',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, {
        triggerType: 'automatic',
        triggerSchedule: '0 9 * * 1',
        triggerLeadDays: 14,
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.template.triggerType, 'automatic');
      assert.strictEqual(body.template.triggerSchedule, '0 9 * * 1');
      assert.strictEqual(body.template.triggerLeadDays, 14);
    });

    it('updates task definitions with new fields', async () => {
      const created = await createTemplate(client, {
        name: 'Update Tasks',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, {
        taskDefinitions: [
          {
            refId: 'announce',
            description: 'Announce event',
            offsetDays: -7,
            isMilestone: false,
            stageOnComplete: 'announced',
            requiresFile: true,
          },
        ],
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const td = body.template.taskDefinitions[0];
      assert.strictEqual(td.isMilestone, false);
      assert.strictEqual(td.stageOnComplete, 'announced');
      assert.strictEqual(td.requiresFile, true);
    });

    it('rejects invalid stageOnComplete in PUT', async () => {
      const created = await createTemplate(client, {
        name: 'PUT Validation',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('PUT', `/api/templates/${created.id}`, {
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0, stageOnComplete: 'bad-value' },
        ],
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('stageOnComplete'));
    });
  });

  describe('GET /api/templates/:id with new fields', () => {
    it('returns all new fields when present', async () => {
      const created = await createTemplate(client, {
        name: 'Full Template',
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
      });

      const res = await invoke('GET', `/api/templates/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      const t = body.template;
      assert.strictEqual(t.emoji, '\u{1F4F0}');
      assert.deepStrictEqual(t.tags, ['weekly']);
      assert.strictEqual(t.defaultAssigneeId, 'user-grace');
      assert.deepStrictEqual(t.references, [{ name: 'Guide', url: 'https://example.com' }]);
      assert.deepStrictEqual(t.bundleLinkDefinitions, [{ name: 'Luma' }]);
      assert.strictEqual(t.triggerType, 'automatic');
      assert.strictEqual(t.triggerSchedule, '0 9 * * 1');
      assert.strictEqual(t.triggerLeadDays, 7);

      const td = t.taskDefinitions[0];
      assert.strictEqual(td.isMilestone, true);
      assert.strictEqual(td.stageOnComplete, 'done');
      assert.strictEqual(td.assigneeId, 'user-valeriia');
      assert.strictEqual(td.requiresFile, false);
      assert.strictEqual(td.requiredLinkName, 'Luma');
    });

    it('returns template without new fields (backward compatibility)', async () => {
      const created = await createTemplate(client, {
        name: 'Old Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });

      const res = await invoke('GET', `/api/templates/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      const t = body.template;
      assert.strictEqual(t.name, 'Old Template');
      assert.strictEqual(t.emoji, undefined);
      assert.strictEqual(t.tags, undefined);
      assert.strictEqual(t.defaultAssigneeId, undefined);
    });
  });

  // ---- Content-Type header ----

  describe('Content-Type header', () => {
    it('all API responses include Content-Type: application/json', async () => {
      const res200 = await invoke('GET', '/api/templates');
      assert.strictEqual(res200.headers!['Content-Type'], 'application/json');

      const res404 = await invoke('GET', '/api/templates/nonexistent');
      assert.strictEqual(res404.headers!['Content-Type'], 'application/json');

      const res201 = await invoke('POST', '/api/templates', {
        name: 'CT Test',
        type: 'test',
        taskDefinitions: [
          { refId: 'a', description: 'Task A', offsetDays: 0 },
        ],
      });
      assert.strictEqual(res201.headers!['Content-Type'], 'application/json');

      const res405 = await invoke('PATCH', '/api/templates');
      assert.strictEqual(res405.headers!['Content-Type'], 'application/json');
    });
  });
});
