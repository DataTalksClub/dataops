import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables, deleteTables } from '../src/db/setup';
import { createBundle } from '../src/db/bundles';
import { createTemplate } from '../src/db/templates';
import { createTask } from '../src/db/tasks';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
  };
  return handler(event, {});
}

describe('API — Bundles', () => {
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
  });

  // ---- POST /api/bundles ----

  describe('POST /api/bundles', () => {
    it('creates a bundle with valid title and anchorDate', async () => {
      const res = await invoke('POST', '/api/bundles', {
        title: 'ML Zoomcamp 2026',
        anchorDate: '2026-06-01',
      });

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.headers!['Content-Type'], 'application/json');

      const body = JSON.parse(res.body);
      assert.ok(body.bundle);
      assert.ok(body.bundle.id);
      assert.strictEqual(body.bundle.title, 'ML Zoomcamp 2026');
      assert.strictEqual(body.bundle.anchorDate, '2026-06-01');
      assert.strictEqual(body.bundle.stage, 'preparation');
      assert.strictEqual(body.bundle.status, 'active');
      assert.ok(body.bundle.createdAt);
      assert.ok(body.bundle.updatedAt);
      assert.strictEqual(body.tasks, undefined);
    });

    it('creates a bundle with optional description', async () => {
      const res = await invoke('POST', '/api/bundles', {
        title: 'Newsletter',
        anchorDate: '2026-03-01',
        description: 'Weekly newsletter',
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.bundle.description, 'Weekly newsletter');
    });

    it('creates a bundle with all new fields', async () => {
      const res = await invoke('POST', '/api/bundles', {
        title: 'Newsletter Mar 2026',
        anchorDate: '2026-03-15',
        emoji: '📰',
        tags: ['newsletter'],
        references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
        bundleLinks: [{ name: 'Luma', url: '' }],
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.bundle.emoji, '📰');
      assert.deepStrictEqual(body.bundle.tags, ['newsletter']);
      assert.deepStrictEqual(body.bundle.references, [{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
      assert.deepStrictEqual(body.bundle.bundleLinks, [{ name: 'Luma', url: '' }]);
      assert.strictEqual(body.bundle.stage, 'preparation');
      assert.strictEqual(body.bundle.status, 'active');
    });

    it('creates a bundle with only required fields (backward compatibility)', async () => {
      const res = await invoke('POST', '/api/bundles', {
        title: 'Simple Bundle',
        anchorDate: '2026-04-01',
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.bundle.stage, 'preparation');
      assert.strictEqual(body.bundle.status, 'active');
      assert.strictEqual(body.bundle.emoji, undefined);
      assert.strictEqual(body.bundle.tags, undefined);
      assert.strictEqual(body.bundle.references, undefined);
      assert.strictEqual(body.bundle.bundleLinks, undefined);
    });

    it('creates a bundle with a template and instantiates tasks', async () => {
      const template = await createTemplate(client, {
        name: 'Event Template',
        taskDefinitions: [
          { refId: 'prep', description: 'Prepare materials', offsetDays: -7 },
          { refId: 'event', description: 'Run event', offsetDays: 0 },
          { refId: 'followup', description: 'Follow up', offsetDays: 3 },
        ],
      });

      const res = await invoke('POST', '/api/bundles', {
        title: 'Community Meetup',
        anchorDate: '2026-04-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);

      assert.ok(body.bundle);
      assert.strictEqual(body.bundle.templateId, template.id);

      assert.ok(body.tasks);
      assert.strictEqual(body.tasks.length, 3);

      const dates = body.tasks.map((t: any) => t.date).sort();
      assert.deepStrictEqual(dates, ['2026-04-08', '2026-04-15', '2026-04-18']);

      for (const task of body.tasks) {
        assert.strictEqual(task.bundleId, body.bundle.id);
        assert.strictEqual(task.source, 'template');
      }
    });

    it('returns 404 when templateId does not exist', async () => {
      const res = await invoke('POST', '/api/bundles', {
        title: 'Test',
        anchorDate: '2026-01-01',
        templateId: 'nonexistent-id',
      });

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Template not found');
    });

    it('returns 400 when title is missing', async () => {
      const res = await invoke('POST', '/api/bundles', {
        anchorDate: '2026-06-01',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('title'));
    });

    it('returns 400 when title is empty string', async () => {
      const res = await invoke('POST', '/api/bundles', {
        title: '  ',
        anchorDate: '2026-06-01',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('title'));
    });

    it('returns 400 when anchorDate is missing', async () => {
      const res = await invoke('POST', '/api/bundles', {
        title: 'Test',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('anchordate'));
    });

    it('returns 400 for malformed JSON body', async () => {
      const res = await invoke('POST', '/api/bundles', 'not valid json{{');

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Invalid JSON');
    });
  });

  // ---- GET /api/bundles ----

  describe('GET /api/bundles', () => {
    it('returns 200 with an array of bundles', async () => {
      const res = await invoke('GET', '/api/bundles');

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers!['Content-Type'], 'application/json');

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.bundles));
      assert.ok(body.bundles.length > 0);
    });
  });

  // ---- GET /api/bundles/:id ----

  describe('GET /api/bundles/:id', () => {
    it('returns 200 with the bundle for a valid id', async () => {
      const created = await createBundle(client, {
        title: 'My Bundle',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('GET', `/api/bundles/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(body.bundle);
      assert.strictEqual(body.bundle.id, created.id);
      assert.strictEqual(body.bundle.title, 'My Bundle');
    });

    it('returns 404 for a non-existent bundle', async () => {
      const res = await invoke('GET', '/api/bundles/does-not-exist');

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Bundle not found');
    });

    it('returns bundle with all new fields via GET', async () => {
      const created = await createBundle(client, {
        title: 'Full Bundle',
        anchorDate: '2026-07-01',
        emoji: '🎙️',
        tags: ['podcast'],
        references: [{ name: 'Overview', url: 'https://example.com/overview' }],
        bundleLinks: [{ name: 'YouTube', url: 'https://youtube.com/123' }],
        stage: 'announced',
        status: 'active',
      });

      const res = await invoke('GET', `/api/bundles/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.bundle.emoji, '🎙️');
      assert.deepStrictEqual(body.bundle.tags, ['podcast']);
      assert.deepStrictEqual(body.bundle.references, [{ name: 'Overview', url: 'https://example.com/overview' }]);
      assert.deepStrictEqual(body.bundle.bundleLinks, [{ name: 'YouTube', url: 'https://youtube.com/123' }]);
      assert.strictEqual(body.bundle.stage, 'announced');
      assert.strictEqual(body.bundle.status, 'active');
    });

    it('existing bundle without new fields still works', async () => {
      const created = await createBundle(client, {
        title: 'Old style bundle',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('GET', `/api/bundles/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(body.bundle);
      assert.strictEqual(body.bundle.title, 'Old style bundle');
    });
  });

  // ---- PUT /api/bundles/:id ----

  describe('PUT /api/bundles/:id', () => {
    it('updates a bundle and returns 200', async () => {
      const created = await createBundle(client, {
        title: 'Old Title',
        anchorDate: '2026-01-01',
      });

      await new Promise((r) => setTimeout(r, 10));

      const res = await invoke('PUT', `/api/bundles/${created.id}`, {
        title: 'New Title',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.bundle.title, 'New Title');
      assert.ok(body.bundle.updatedAt > created.updatedAt);
    });

    it('updates stage to announced', async () => {
      const created = await createBundle(client, {
        title: 'Stage test',
        anchorDate: '2026-01-01',
        stage: 'preparation',
      });

      const res = await invoke('PUT', `/api/bundles/${created.id}`, {
        stage: 'announced',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.bundle.stage, 'announced');
    });

    it('rejects invalid stage value', async () => {
      const created = await createBundle(client, {
        title: 'Invalid stage test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/bundles/${created.id}`, {
        stage: 'invalid-stage',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Invalid stage'));
    });

    it('rejects invalid status value', async () => {
      const created = await createBundle(client, {
        title: 'Invalid status test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/bundles/${created.id}`, {
        status: 'invalid-status',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Invalid status'));
    });

    it('updates references and bundleLinks', async () => {
      const created = await createBundle(client, {
        title: 'Links update test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/bundles/${created.id}`, {
        references: [{ name: 'Process doc', url: 'https://docs.google.com/proc' }],
        bundleLinks: [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }],
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body.bundle.references, [{ name: 'Process doc', url: 'https://docs.google.com/proc' }]);
      assert.deepStrictEqual(body.bundle.bundleLinks, [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }]);
    });

    it('updates emoji and tags', async () => {
      const created = await createBundle(client, {
        title: 'Emoji tags update',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/bundles/${created.id}`, {
        emoji: '📰',
        tags: ['newsletter', 'weekly'],
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.bundle.emoji, '📰');
      assert.deepStrictEqual(body.bundle.tags, ['newsletter', 'weekly']);
    });

    it('returns 404 when updating a non-existent bundle', async () => {
      const res = await invoke('PUT', '/api/bundles/does-not-exist', {
        title: 'New',
      });

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Bundle not found');
    });

    it('returns 400 when body is empty', async () => {
      const created = await createBundle(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/bundles/${created.id}`, {});

      assert.strictEqual(res.statusCode, 400);
    });

    it('returns 400 for malformed JSON', async () => {
      const created = await createBundle(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/bundles/${created.id}`, 'bad json');
      assert.strictEqual(res.statusCode, 400);
    });
  });

  // ---- PUT /api/bundles/:id/archive ----

  describe('PUT /api/bundles/:id/archive', () => {
    it('archives a bundle and returns 200', async () => {
      const created = await createBundle(client, {
        title: 'Archive me',
        anchorDate: '2026-01-01',
        status: 'active',
      });

      const res = await invoke('PUT', `/api/bundles/${created.id}/archive`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.bundle.status, 'archived');
      assert.strictEqual(body.bundle.id, created.id);
    });

    it('returns 404 for a non-existent bundle', async () => {
      const res = await invoke('PUT', '/api/bundles/does-not-exist/archive');
      assert.strictEqual(res.statusCode, 404);
    });

    it('returns 405 for non-PUT methods', async () => {
      const created = await createBundle(client, {
        title: 'Method test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('GET', `/api/bundles/${created.id}/archive`);
      assert.strictEqual(res.statusCode, 405);
    });
  });

  // ---- DELETE /api/bundles/:id ----

  describe('DELETE /api/bundles/:id', () => {
    it('deletes an archived bundle and returns 204', async () => {
      const created = await createBundle(client, {
        title: 'Delete me',
        anchorDate: '2026-01-01',
        status: 'archived',
      });

      const res = await invoke('DELETE', `/api/bundles/${created.id}`);
      assert.strictEqual(res.statusCode, 204);

      const getRes = await invoke('GET', `/api/bundles/${created.id}`);
      assert.strictEqual(getRes.statusCode, 404);
    });

    it('returns 400 when deleting a non-archived bundle', async () => {
      const created = await createBundle(client, {
        title: 'Active bundle',
        anchorDate: '2026-01-01',
        status: 'active',
      });

      const res = await invoke('DELETE', `/api/bundles/${created.id}`);
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Only archived bundles can be deleted');
    });

    it('returns 400 when deleting a bundle without status set', async () => {
      const created = await createBundle(client, {
        title: 'No status bundle',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('DELETE', `/api/bundles/${created.id}`);
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Only archived bundles can be deleted');
    });

    it('returns 404 when deleting a non-existent bundle', async () => {
      const res = await invoke('DELETE', '/api/bundles/does-not-exist');
      assert.strictEqual(res.statusCode, 404);
    });
  });

  // ---- GET /api/bundles/:id/tasks ----

  describe('GET /api/bundles/:id/tasks', () => {
    it('returns tasks for a bundle', async () => {
      const bundle = await createBundle(client, {
        title: 'Task List Bundle',
        anchorDate: '2026-01-01',
      });

      await createTask(client, {
        description: 'Task 1',
        bundleId: bundle.id,
        date: '2026-01-01',
        status: 'todo',
      });
      await createTask(client, {
        description: 'Task 2',
        bundleId: bundle.id,
        date: '2026-01-02',
        status: 'todo',
      });

      const res = await invoke('GET', `/api/bundles/${bundle.id}/tasks`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.tasks));
      assert.strictEqual(body.tasks.length, 2);
      for (const task of body.tasks) {
        assert.strictEqual(task.bundleId, bundle.id);
      }
    });

    it('returns empty tasks array for bundle with no tasks', async () => {
      const bundle = await createBundle(client, {
        title: 'No Tasks Bundle',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('GET', `/api/bundles/${bundle.id}/tasks`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.tasks));
      assert.strictEqual(body.tasks.length, 0);
    });

    it('returns 404 for tasks of a non-existent bundle', async () => {
      const res = await invoke('GET', '/api/bundles/does-not-exist/tasks');
      assert.strictEqual(res.statusCode, 404);
    });
  });

  // ---- Old /api/projects returns 404 ----

  describe('Old /api/projects returns 404', () => {
    it('GET /api/projects returns 404', async () => {
      const res = await invoke('GET', '/api/projects');
      assert.strictEqual(res.statusCode, 404);
    });
  });

  // ---- Method not allowed ----

  describe('Method not allowed', () => {
    it('returns 405 for PATCH /api/bundles', async () => {
      const res = await invoke('PATCH', '/api/bundles');
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });

    it('returns 405 for POST /api/bundles/:id', async () => {
      const bundle = await createBundle(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });
      const res = await invoke('POST', `/api/bundles/${bundle.id}`);
      assert.strictEqual(res.statusCode, 405);
    });

    it('returns 405 for PATCH /api/bundles/:id', async () => {
      const bundle = await createBundle(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });
      const res = await invoke('PATCH', `/api/bundles/${bundle.id}`);
      assert.strictEqual(res.statusCode, 405);
    });

    it('returns 405 for POST /api/bundles/:id/tasks', async () => {
      const bundle = await createBundle(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });
      const res = await invoke('POST', `/api/bundles/${bundle.id}/tasks`);
      assert.strictEqual(res.statusCode, 405);
    });
  });

  // ---- Content-Type header ----

  describe('Content-Type header', () => {
    it('all API responses include Content-Type: application/json', async () => {
      const res200 = await invoke('GET', '/api/bundles');
      assert.strictEqual(res200.headers!['Content-Type'], 'application/json');

      const res404 = await invoke('GET', '/api/bundles/nonexistent');
      assert.strictEqual(res404.headers!['Content-Type'], 'application/json');

      const res201 = await invoke('POST', '/api/bundles', {
        title: 'CT Test',
        anchorDate: '2026-01-01',
      });
      assert.strictEqual(res201.headers!['Content-Type'], 'application/json');

      const res405 = await invoke('PATCH', '/api/bundles');
      assert.strictEqual(res405.headers!['Content-Type'], 'application/json');
    });
  });

  // ---- Issue #20: Template instantiation with new fields ----

  describe('Template instantiation with new fields (issue #20)', () => {
    it('bundle inherits emoji, tags, references, and bundleLinks from template', async () => {
      const template = await createTemplate(client, {
        name: 'Full Template',
        type: 'event',
        emoji: '📰',
        tags: ['newsletter', 'weekly'],
        references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
        bundleLinkDefinitions: [{ name: 'Luma' }, { name: 'YouTube' }],
        taskDefinitions: [
          { refId: 'prep', description: 'Prepare', offsetDays: -7 },
        ],
      });

      const res = await invoke('POST', '/api/bundles', {
        title: 'Inherited Bundle',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);

      assert.strictEqual(body.bundle.emoji, '📰');
      assert.deepStrictEqual(body.bundle.tags, ['newsletter', 'weekly']);
      assert.deepStrictEqual(body.bundle.references, [{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
      assert.deepStrictEqual(body.bundle.bundleLinks, [{ name: 'Luma', url: '' }, { name: 'YouTube', url: '' }]);
    });

    it('caller-provided values override template values', async () => {
      const template = await createTemplate(client, {
        name: 'Override Template',
        type: 'event',
        emoji: '📰',
        tags: ['newsletter'],
        taskDefinitions: [
          { refId: 'prep', description: 'Prepare', offsetDays: 0 },
        ],
      });

      const res = await invoke('POST', '/api/bundles', {
        title: 'Override Bundle',
        anchorDate: '2026-06-15',
        templateId: template.id,
        emoji: '🎉',
        tags: ['custom'],
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);

      assert.strictEqual(body.bundle.emoji, '🎉');
      assert.deepStrictEqual(body.bundle.tags, ['custom']);
    });

    it('tasks have instructionsUrl set correctly (not in comment)', async () => {
      const template = await createTemplate(client, {
        name: 'Instructions Template',
        type: 'test',
        taskDefinitions: [
          {
            refId: 'inst',
            description: 'Task with instructions',
            offsetDays: 0,
            instructionsUrl: 'https://docs.google.com/instructions',
          },
        ],
      });

      const res = await invoke('POST', '/api/bundles', {
        title: 'Instructions Bundle',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.tasks[0].instructionsUrl, 'https://docs.google.com/instructions');
      assert.strictEqual(body.tasks[0].comment, undefined);
    });

    it('tasks inherit assigneeId with fallback to defaultAssigneeId', async () => {
      const template = await createTemplate(client, {
        name: 'Assignee Template',
        type: 'test',
        defaultAssigneeId: 'user-grace',
        taskDefinitions: [
          { refId: 'specific', description: 'Specific assignee', offsetDays: 0, assigneeId: 'user-valeriia' },
          { refId: 'default', description: 'Default assignee', offsetDays: 1 },
        ],
      });

      const res = await invoke('POST', '/api/bundles', {
        title: 'Assignee Bundle',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);

      const specific = body.tasks.find((t: any) => t.templateTaskRef === 'specific');
      const defaultTask = body.tasks.find((t: any) => t.templateTaskRef === 'default');

      assert.strictEqual(specific.assigneeId, 'user-valeriia');
      assert.strictEqual(defaultTask.assigneeId, 'user-grace');
    });

    it('tasks inherit requiredLinkName from task definition', async () => {
      const template = await createTemplate(client, {
        name: 'RequiredLink Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'with-link', description: 'Needs Luma', offsetDays: 0, requiredLinkName: 'Luma' },
        ],
      });

      const res = await invoke('POST', '/api/bundles', {
        title: 'RequiredLink Bundle',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.tasks[0].requiredLinkName, 'Luma');
    });

    it('tasks inherit tags from template', async () => {
      const template = await createTemplate(client, {
        name: 'Tags Template',
        type: 'test',
        tags: ['podcast', 'content'],
        taskDefinitions: [
          { refId: 'task1', description: 'Task 1', offsetDays: 0 },
          { refId: 'task2', description: 'Task 2', offsetDays: 1 },
        ],
      });

      const res = await invoke('POST', '/api/bundles', {
        title: 'Tags Bundle',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      for (const task of body.tasks) {
        assert.deepStrictEqual(task.tags, ['podcast', 'content']);
      }
    });

    it('milestone task completion triggers stage transition', async () => {
      const template = await createTemplate(client, {
        name: 'Stage Transition Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'milestone', description: 'Stream', offsetDays: 0, isMilestone: true, stageOnComplete: 'after-event' },
          { refId: 'regular', description: 'Regular task', offsetDays: 1 },
        ],
      });

      const createRes = await invoke('POST', '/api/bundles', {
        title: 'Stage Transition Bundle',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(createRes.statusCode, 201);
      const createBody = JSON.parse(createRes.body);
      const bundleId = createBody.bundle.id;

      // Verify bundle starts at "preparation"
      assert.strictEqual(createBody.bundle.stage, 'preparation');

      // Find the milestone task
      const milestoneTask = createBody.tasks.find((t: any) => t.templateTaskRef === 'milestone');
      assert.ok(milestoneTask);

      // Mark milestone task as done
      const updateRes = await invoke('PUT', `/api/tasks/${milestoneTask.id}`, {
        status: 'done',
      });
      assert.strictEqual(updateRes.statusCode, 200);

      // Verify bundle stage changed to "after-event"
      const bundleRes = await invoke('GET', `/api/bundles/${bundleId}`);
      assert.strictEqual(bundleRes.statusCode, 200);
      const bundleBody = JSON.parse(bundleRes.body);
      assert.strictEqual(bundleBody.bundle.stage, 'after-event');
    });

    it('non-milestone task completion does not trigger stage transition', async () => {
      const template = await createTemplate(client, {
        name: 'No Stage Transition Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'milestone', description: 'Stream', offsetDays: 0, isMilestone: true, stageOnComplete: 'after-event' },
          { refId: 'regular', description: 'Regular task', offsetDays: 1 },
        ],
      });

      const createRes = await invoke('POST', '/api/bundles', {
        title: 'No Stage Transition Bundle',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(createRes.statusCode, 201);
      const createBody = JSON.parse(createRes.body);
      const bundleId = createBody.bundle.id;

      // Find the regular task (no stageOnComplete)
      const regularTask = createBody.tasks.find((t: any) => t.templateTaskRef === 'regular');
      assert.ok(regularTask);

      // Mark regular task as done
      const updateRes = await invoke('PUT', `/api/tasks/${regularTask.id}`, {
        status: 'done',
      });
      assert.strictEqual(updateRes.statusCode, 200);

      // Verify bundle stage is still "preparation"
      const bundleRes = await invoke('GET', `/api/bundles/${bundleId}`);
      assert.strictEqual(bundleRes.statusCode, 200);
      const bundleBody = JSON.parse(bundleRes.body);
      assert.strictEqual(bundleBody.bundle.stage, 'preparation');
    });

    it('task dates are correctly calculated from anchor date and offset days', async () => {
      const template = await createTemplate(client, {
        name: 'Date Calc Template',
        type: 'test',
        taskDefinitions: [
          { refId: 'd-14', description: 'Two weeks before', offsetDays: -14 },
          { refId: 'd-7', description: 'One week before', offsetDays: -7 },
          { refId: 'd0', description: 'Anchor day', offsetDays: 0, isMilestone: true },
          { refId: 'd3', description: 'Three days after', offsetDays: 3 },
          { refId: 'd7', description: 'One week after', offsetDays: 7 },
        ],
      });

      const res = await invoke('POST', '/api/bundles', {
        title: 'Date Calc Bundle',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);

      const dates = body.tasks.map((t: any) => t.date).sort();
      assert.deepStrictEqual(dates, ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-18', '2026-06-22']);
    });
  });
});
