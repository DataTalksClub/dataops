import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables, deleteTables } from '../src/db/setup';
import { createCard } from '../src/db/cards';
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

describe('API — Cards', () => {
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

  // ---- POST /api/cards ----

  describe('POST /api/cards', () => {
    it('creates a card with valid title and anchorDate', async () => {
      const res = await invoke('POST', '/api/cards', {
        title: 'ML Zoomcamp 2026',
        anchorDate: '2026-06-01',
      });

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.headers!['Content-Type'], 'application/json');

      const body = JSON.parse(res.body);
      assert.ok(body.card);
      assert.ok(body.card.id);
      assert.strictEqual(body.card.title, 'ML Zoomcamp 2026');
      assert.strictEqual(body.card.anchorDate, '2026-06-01');
      assert.strictEqual(body.card.stage, 'preparation');
      assert.strictEqual(body.card.status, 'active');
      assert.ok(body.card.createdAt);
      assert.ok(body.card.updatedAt);
      assert.strictEqual(body.tasks, undefined);
    });

    it('creates a card with optional description', async () => {
      const res = await invoke('POST', '/api/cards', {
        title: 'Newsletter',
        anchorDate: '2026-03-01',
        description: 'Weekly newsletter',
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.card.description, 'Weekly newsletter');
    });

    it('creates a card with all new fields', async () => {
      const res = await invoke('POST', '/api/cards', {
        title: 'Newsletter Mar 2026',
        anchorDate: '2026-03-15',
        emoji: '📰',
        tags: ['newsletter'],
        references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
        cardLinks: [{ name: 'Luma', url: '' }],
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.card.emoji, '📰');
      assert.deepStrictEqual(body.card.tags, ['newsletter']);
      assert.deepStrictEqual(body.card.references, [{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
      assert.deepStrictEqual(body.card.cardLinks, [{ name: 'Luma', url: '' }]);
      assert.strictEqual(body.card.stage, 'preparation');
      assert.strictEqual(body.card.status, 'active');
    });

    it('creates a card with only required fields (backward compatibility)', async () => {
      const res = await invoke('POST', '/api/cards', {
        title: 'Simple Card',
        anchorDate: '2026-04-01',
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.card.stage, 'preparation');
      assert.strictEqual(body.card.status, 'active');
      assert.strictEqual(body.card.emoji, undefined);
      assert.strictEqual(body.card.tags, undefined);
      assert.strictEqual(body.card.references, undefined);
      assert.strictEqual(body.card.cardLinks, undefined);
    });

    it('creates a card with a template and instantiates tasks', async () => {
      const template = await createTemplate(client, {
        name: 'Event Template',
        sourceRevision: 'synthetic-revision-1',
        tags: ['event'],
        taskDefinitions: [
          { refId: 'prep', description: 'Prepare materials', offsetDays: -7 },
          { refId: 'event', description: 'Run event', offsetDays: 0 },
          { refId: 'followup', description: 'Follow up', offsetDays: 3 },
        ],
      });

      const res = await invoke('POST', '/api/cards', {
        title: 'Community Meetup',
        anchorDate: '2026-04-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);

      assert.ok(body.card);
      assert.strictEqual(body.card.templateId, template.id);
      assert.strictEqual(body.card.version, 1);
      assert.strictEqual(body.card.templateVersion, template.version);
      assert.strictEqual(body.card.templateSourceRevision, 'synthetic-revision-1');
      assert.deepStrictEqual(body.card.templateDefinitionSnapshot.tags, ['event']);

      assert.ok(body.tasks);
      assert.strictEqual(body.tasks.length, 3);

      const dates = body.tasks.map((t: any) => t.date).sort();
      assert.deepStrictEqual(dates, ['2026-04-08', '2026-04-15', '2026-04-18']);

      for (const [order, task] of body.tasks.entries()) {
        assert.strictEqual(task.cardId, body.card.id);
        assert.strictEqual(task.source, 'template');
        assert.strictEqual(task.version, 1);
        assert.strictEqual(task.templateVersion, template.version);
        assert.strictEqual(task.templateSourceRevision, 'synthetic-revision-1');
        assert.strictEqual(task.templateTaskOrder, order);
        assert.strictEqual(task.templateDefinitionSnapshot.description, task.description);
        assert.strictEqual(task.templateDefinitionSnapshot.date, task.date);
      }
    });

    it('returns 404 when templateId does not exist', async () => {
      const res = await invoke('POST', '/api/cards', {
        title: 'Test',
        anchorDate: '2026-01-01',
        templateId: 'nonexistent-id',
      });

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Template not found');
    });

    it('returns 400 when title is missing', async () => {
      const res = await invoke('POST', '/api/cards', {
        anchorDate: '2026-06-01',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('title'));
    });

    it('returns 400 when title is empty string', async () => {
      const res = await invoke('POST', '/api/cards', {
        title: '  ',
        anchorDate: '2026-06-01',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('title'));
    });

    it('returns 400 when anchorDate is missing', async () => {
      const res = await invoke('POST', '/api/cards', {
        title: 'Test',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('anchordate'));
    });

    it('returns 400 for malformed JSON body', async () => {
      const res = await invoke('POST', '/api/cards', 'not valid json{{');

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Invalid JSON');
    });
  });

  // ---- GET /api/cards ----

  describe('GET /api/cards', () => {
    it('returns 200 with an array of cards', async () => {
      const res = await invoke('GET', '/api/cards');

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers!['Content-Type'], 'application/json');

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.cards));
      assert.ok(body.cards.length > 0);
    });
  });

  // ---- GET /api/cards/:id ----

  describe('GET /api/cards/:id', () => {
    it('returns 200 with the card for a valid id', async () => {
      const created = await createCard(client, {
        title: 'My Card',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('GET', `/api/cards/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(body.card);
      assert.strictEqual(body.card.id, created.id);
      assert.strictEqual(body.card.title, 'My Card');
    });

    it('returns 404 for a non-existent card', async () => {
      const res = await invoke('GET', '/api/cards/does-not-exist');

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Card not found');
    });

    it('returns card with all new fields via GET', async () => {
      const created = await createCard(client, {
        title: 'Full Card',
        anchorDate: '2026-07-01',
        emoji: '🎙️',
        tags: ['podcast'],
        references: [{ name: 'Overview', url: 'https://example.com/overview' }],
        cardLinks: [{ name: 'YouTube', url: 'https://youtube.com/123' }],
        stage: 'announced',
        status: 'active',
      });

      const res = await invoke('GET', `/api/cards/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.card.emoji, '🎙️');
      assert.deepStrictEqual(body.card.tags, ['podcast']);
      assert.deepStrictEqual(body.card.references, [{ name: 'Overview', url: 'https://example.com/overview' }]);
      assert.deepStrictEqual(body.card.cardLinks, [{ name: 'YouTube', url: 'https://youtube.com/123' }]);
      assert.strictEqual(body.card.stage, 'announced');
      assert.strictEqual(body.card.status, 'active');
    });

    it('existing card without new fields still works', async () => {
      const created = await createCard(client, {
        title: 'Old style card',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('GET', `/api/cards/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(body.card);
      assert.strictEqual(body.card.title, 'Old style card');
    });
  });

  // ---- PUT /api/cards/:id ----

  describe('PUT /api/cards/:id', () => {
    it('updates a card and returns 200', async () => {
      const created = await createCard(client, {
        title: 'Old Title',
        anchorDate: '2026-01-01',
      });

      await new Promise((r) => setTimeout(r, 10));

      const res = await invoke('PUT', `/api/cards/${created.id}`, {
        title: 'New Title',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.card.title, 'New Title');
      assert.ok(body.card.updatedAt > created.updatedAt);
    });

    it('updates stage to announced', async () => {
      const created = await createCard(client, {
        title: 'Stage test',
        anchorDate: '2026-01-01',
        stage: 'preparation',
      });

      const res = await invoke('PUT', `/api/cards/${created.id}`, {
        stage: 'announced',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.card.stage, 'announced');
    });

    it('rejects invalid stage value', async () => {
      const created = await createCard(client, {
        title: 'Invalid stage test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/cards/${created.id}`, {
        stage: 'invalid-stage',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Invalid stage'));
    });

    it('rejects invalid status value', async () => {
      const created = await createCard(client, {
        title: 'Invalid status test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/cards/${created.id}`, {
        status: 'invalid-status',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Invalid status'));
    });

    it('updates references and cardLinks', async () => {
      const created = await createCard(client, {
        title: 'Links update test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/cards/${created.id}`, {
        references: [{ name: 'Process doc', url: 'https://docs.google.com/proc' }],
        cardLinks: [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }],
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body.card.references, [{ name: 'Process doc', url: 'https://docs.google.com/proc' }]);
      assert.deepStrictEqual(body.card.cardLinks, [{ name: 'YouTube', url: 'https://youtube.com/watch?v=123' }]);
    });

    it('updates emoji and tags', async () => {
      const created = await createCard(client, {
        title: 'Emoji tags update',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/cards/${created.id}`, {
        emoji: '📰',
        tags: ['newsletter', 'weekly'],
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.card.emoji, '📰');
      assert.deepStrictEqual(body.card.tags, ['newsletter', 'weekly']);
    });

    it('returns 404 when updating a non-existent card', async () => {
      const res = await invoke('PUT', '/api/cards/does-not-exist', {
        title: 'New',
      });

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Card not found');
    });

    it('returns 400 when body is empty', async () => {
      const created = await createCard(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/cards/${created.id}`, {});

      assert.strictEqual(res.statusCode, 400);
    });

    it('returns 400 for malformed JSON', async () => {
      const created = await createCard(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('PUT', `/api/cards/${created.id}`, 'bad json');
      assert.strictEqual(res.statusCode, 400);
    });
  });

  // ---- PUT /api/cards/:id/archive ----

  describe('PUT /api/cards/:id/archive', () => {
    it('archives a card and returns 200', async () => {
      const created = await createCard(client, {
        title: 'Archive me',
        anchorDate: '2026-01-01',
        status: 'active',
      });

      const res = await invoke('PUT', `/api/cards/${created.id}/archive`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.card.status, 'archived');
      assert.strictEqual(body.card.id, created.id);
    });

    it('returns 404 for a non-existent card', async () => {
      const res = await invoke('PUT', '/api/cards/does-not-exist/archive');
      assert.strictEqual(res.statusCode, 404);
    });

    it('returns 405 for non-PUT methods', async () => {
      const created = await createCard(client, {
        title: 'Method test',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('GET', `/api/cards/${created.id}/archive`);
      assert.strictEqual(res.statusCode, 405);
    });
  });

  // ---- DELETE /api/cards/:id ----

  describe('DELETE /api/cards/:id', () => {
    it('deletes an archived card and returns 204', async () => {
      const created = await createCard(client, {
        title: 'Delete me',
        anchorDate: '2026-01-01',
        status: 'archived',
      });

      const res = await invoke('DELETE', `/api/cards/${created.id}`);
      assert.strictEqual(res.statusCode, 204);

      const getRes = await invoke('GET', `/api/cards/${created.id}`);
      assert.strictEqual(getRes.statusCode, 404);
    });

    it('returns 400 when deleting a non-archived card', async () => {
      const created = await createCard(client, {
        title: 'Active card',
        anchorDate: '2026-01-01',
        status: 'active',
      });

      const res = await invoke('DELETE', `/api/cards/${created.id}`);
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Only archived cards can be deleted');
    });

    it('returns 400 when deleting a card without status set', async () => {
      const created = await createCard(client, {
        title: 'No status card',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('DELETE', `/api/cards/${created.id}`);
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Only archived cards can be deleted');
    });

    it('returns 404 when deleting a non-existent card', async () => {
      const res = await invoke('DELETE', '/api/cards/does-not-exist');
      assert.strictEqual(res.statusCode, 404);
    });
  });

  // ---- GET /api/cards/:id/tasks ----

  describe('GET /api/cards/:id/tasks', () => {
    it('returns tasks for a card', async () => {
      const card = await createCard(client, {
        title: 'Task List Card',
        anchorDate: '2026-01-01',
      });

      await createTask(client, {
        description: 'Task 1',
        cardId: card.id,
        date: '2026-01-01',
        status: 'todo',
      });
      await createTask(client, {
        description: 'Task 2',
        cardId: card.id,
        date: '2026-01-02',
        status: 'todo',
      });

      const res = await invoke('GET', `/api/cards/${card.id}/tasks`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.tasks));
      assert.strictEqual(body.tasks.length, 2);
      for (const task of body.tasks) {
        assert.strictEqual(task.cardId, card.id);
      }
    });

    it('returns empty tasks array for card with no tasks', async () => {
      const card = await createCard(client, {
        title: 'No Tasks Card',
        anchorDate: '2026-01-01',
      });

      const res = await invoke('GET', `/api/cards/${card.id}/tasks`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.tasks));
      assert.strictEqual(body.tasks.length, 0);
    });

    it('returns 404 for tasks of a non-existent card', async () => {
      const res = await invoke('GET', '/api/cards/does-not-exist/tasks');
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
    it('returns 405 for PATCH /api/cards', async () => {
      const res = await invoke('PATCH', '/api/cards');
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });

    it('returns 405 for POST /api/cards/:id', async () => {
      const card = await createCard(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });
      const res = await invoke('POST', `/api/cards/${card.id}`);
      assert.strictEqual(res.statusCode, 405);
    });

    it('returns 405 for PATCH /api/cards/:id', async () => {
      const card = await createCard(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });
      const res = await invoke('PATCH', `/api/cards/${card.id}`);
      assert.strictEqual(res.statusCode, 405);
    });

    it('returns 405 for POST /api/cards/:id/tasks', async () => {
      const card = await createCard(client, {
        title: 'Test',
        anchorDate: '2026-01-01',
      });
      const res = await invoke('POST', `/api/cards/${card.id}/tasks`);
      assert.strictEqual(res.statusCode, 405);
    });
  });

  // ---- Content-Type header ----

  describe('Content-Type header', () => {
    it('all API responses include Content-Type: application/json', async () => {
      const res200 = await invoke('GET', '/api/cards');
      assert.strictEqual(res200.headers!['Content-Type'], 'application/json');

      const res404 = await invoke('GET', '/api/cards/nonexistent');
      assert.strictEqual(res404.headers!['Content-Type'], 'application/json');

      const res201 = await invoke('POST', '/api/cards', {
        title: 'CT Test',
        anchorDate: '2026-01-01',
      });
      assert.strictEqual(res201.headers!['Content-Type'], 'application/json');

      const res405 = await invoke('PATCH', '/api/cards');
      assert.strictEqual(res405.headers!['Content-Type'], 'application/json');
    });
  });

  // ---- Issue #20: Template instantiation with new fields ----

  describe('Template instantiation with new fields (issue #20)', () => {
    it('card inherits emoji, tags, references, and cardLinks from template', async () => {
      const template = await createTemplate(client, {
        name: 'Full Template',
        type: 'event',
        emoji: '📰',
        tags: ['newsletter', 'weekly'],
        references: [{ name: 'Style guide', url: 'https://docs.google.com/style' }],
        cardLinkDefinitions: [{ name: 'Luma' }, { name: 'YouTube' }],
        taskDefinitions: [
          { refId: 'prep', description: 'Prepare', offsetDays: -7 },
        ],
      });

      const res = await invoke('POST', '/api/cards', {
        title: 'Inherited Card',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);

      assert.strictEqual(body.card.emoji, '📰');
      assert.deepStrictEqual(body.card.tags, ['newsletter', 'weekly']);
      assert.deepStrictEqual(body.card.references, [{ name: 'Style guide', url: 'https://docs.google.com/style' }]);
      assert.deepStrictEqual(body.card.cardLinks, [{ name: 'Luma', url: '' }, { name: 'YouTube', url: '' }]);
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

      const res = await invoke('POST', '/api/cards', {
        title: 'Override Card',
        anchorDate: '2026-06-15',
        templateId: template.id,
        emoji: '🎉',
        tags: ['custom'],
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);

      assert.strictEqual(body.card.emoji, '🎉');
      assert.deepStrictEqual(body.card.tags, ['custom']);
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

      const res = await invoke('POST', '/api/cards', {
        title: 'Instructions Card',
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

      const res = await invoke('POST', '/api/cards', {
        title: 'Assignee Card',
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

      const res = await invoke('POST', '/api/cards', {
        title: 'RequiredLink Card',
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

      const res = await invoke('POST', '/api/cards', {
        title: 'Tags Card',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      for (const task of body.tasks) {
        assert.deepStrictEqual(task.tags, ['podcast', 'content']);
      }
    });

    it('creates a representative workflow card with task proof and relationship refs', async () => {
      const template = await createTemplate(client, {
        name: 'Representative Workflow Template',
        type: 'workflow',
        tags: ['ops', 'model'],
        defaultAssigneeId: 'user-ops',
        phases: [
          { id: 'intake', name: 'Intake', stage: 'preparation' },
          { id: 'delivery', name: 'Delivery', stage: 'announced' },
        ],
        sourceDocIds: ['workflow.definition.example'],
        references: [{ name: 'Workflow guide', url: 'https://example.com/workflow-guide' }],
        cardLinkDefinitions: [{ name: 'External tracker' }],
        taskDefinitions: [
          {
            refId: 'prepare',
            description: 'Prepare workflow packet',
            offsetDays: -3,
            instructionDocId: 'sop.workflow.prepare-packet',
            instructionStepId: '1',
            phase: 'intake',
            systems: ['github', 'google-drive'],
            validation: { expectedEvidence: 'Tracker URL' },
            requiredLinkName: 'Tracker URL',
            proofRequirement: { type: 'url', label: 'Tracker URL' },
            artifactRefs: [{ artifactId: 'artifact-planned', type: 'document' }],
            assistantJobRefs: [{ assistantJobId: 'assistant-planned', assistantType: 'summary' }],
            auditEventRefs: [{ auditEventId: 'audit-planned', action: 'planned' }],
          },
        ],
      });

      const res = await invoke('POST', '/api/cards', {
        title: 'Representative Workflow Card',
        anchorDate: '2026-07-20',
        templateId: template.id,
        artifactRefs: [{ artifactId: 'card-artifact-planned', type: 'package' }],
        assistantJobRefs: [{ assistantJobId: 'card-assistant-planned', assistantType: 'orchestration' }],
        auditEventRefs: [{ auditEventId: 'card-audit-planned', action: 'created' }],
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);

      assert.ok(body.card.id);
      assert.strictEqual(body.card.templateId, template.id);
      assert.strictEqual(body.card.anchorDate, '2026-07-20');
      assert.strictEqual(body.card.stage, 'preparation');
      assert.strictEqual(body.card.status, 'active');
      assert.deepStrictEqual(body.card.references, [{ name: 'Workflow guide', url: 'https://example.com/workflow-guide' }]);
      assert.deepStrictEqual(body.card.cardLinks, [{ name: 'External tracker', url: '' }]);
      assert.deepStrictEqual(body.card.tags, ['ops', 'model']);
      assert.deepStrictEqual(body.card.artifactRefs, [{ artifactId: 'card-artifact-planned', type: 'package' }]);
      assert.deepStrictEqual(body.card.assistantJobRefs, [{ assistantJobId: 'card-assistant-planned', assistantType: 'orchestration' }]);
      assert.deepStrictEqual(body.card.auditEventRefs, [{ auditEventId: 'card-audit-planned', action: 'created' }]);

      assert.strictEqual(body.tasks.length, 1);
      assert.strictEqual(body.tasks[0].cardId, body.card.id);
      assert.strictEqual(body.tasks[0].templateId, template.id);
      assert.strictEqual(body.tasks[0].templateTaskRef, 'prepare');
      assert.strictEqual(body.tasks[0].date, '2026-07-17');
      assert.strictEqual(body.tasks[0].instructionDocId, 'sop.workflow.prepare-packet');
      assert.strictEqual(body.tasks[0].phase, 'intake');
      assert.deepStrictEqual(body.tasks[0].systems, ['github', 'google-drive']);
      assert.deepStrictEqual(body.tasks[0].proofRequirement, { type: 'url', label: 'Tracker URL' });
      assert.strictEqual(body.tasks[0].requiredLinkName, 'Tracker URL');
      assert.deepStrictEqual(body.tasks[0].artifactRefs, [{ artifactId: 'artifact-planned', type: 'document' }]);
      assert.deepStrictEqual(body.tasks[0].assistantJobRefs, [{ assistantJobId: 'assistant-planned', assistantType: 'summary' }]);
      assert.deepStrictEqual(body.tasks[0].auditEventRefs, [{ auditEventId: 'audit-planned', action: 'planned' }]);
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

      const createRes = await invoke('POST', '/api/cards', {
        title: 'Stage Transition Card',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(createRes.statusCode, 201);
      const createBody = JSON.parse(createRes.body);
      const cardId = createBody.card.id;

      // Verify card starts at "preparation"
      assert.strictEqual(createBody.card.stage, 'preparation');

      // Find the milestone task
      const milestoneTask = createBody.tasks.find((t: any) => t.templateTaskRef === 'milestone');
      assert.ok(milestoneTask);

      // Mark milestone task as done
      const updateRes = await invoke('PUT', `/api/tasks/${milestoneTask.id}`, {
        status: 'done',
      });
      assert.strictEqual(updateRes.statusCode, 200);

      // Verify card stage changed to "after-event"
      const cardRes = await invoke('GET', `/api/cards/${cardId}`);
      assert.strictEqual(cardRes.statusCode, 200);
      const cardBody = JSON.parse(cardRes.body);
      assert.strictEqual(cardBody.card.stage, 'after-event');
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

      const createRes = await invoke('POST', '/api/cards', {
        title: 'No Stage Transition Card',
        anchorDate: '2026-06-15',
        templateId: template.id,
      });

      assert.strictEqual(createRes.statusCode, 201);
      const createBody = JSON.parse(createRes.body);
      const cardId = createBody.card.id;

      // Find the regular task (no stageOnComplete)
      const regularTask = createBody.tasks.find((t: any) => t.templateTaskRef === 'regular');
      assert.ok(regularTask);

      // Mark regular task as done
      const updateRes = await invoke('PUT', `/api/tasks/${regularTask.id}`, {
        status: 'done',
      });
      assert.strictEqual(updateRes.statusCode, 200);

      // Verify card stage is still "preparation"
      const cardRes = await invoke('GET', `/api/cards/${cardId}`);
      assert.strictEqual(cardRes.statusCode, 200);
      const cardBody = JSON.parse(cardRes.body);
      assert.strictEqual(cardBody.card.stage, 'preparation');
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

      const res = await invoke('POST', '/api/cards', {
        title: 'Date Calc Card',
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
