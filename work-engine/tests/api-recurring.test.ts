import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import {
  createRecurringConfig,
  listRecurringConfigs,
  updateRecurringConfig,
} from '../src/db/recurring';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
  };
  return handler(event, {});
}

async function disableAllConfigs(client: DynamoDBDocumentClient): Promise<void> {
  const allConfigs = await listRecurringConfigs(client);
  for (const c of allConfigs) {
    if (c.enabled) {
      await updateRecurringConfig(client, c.id, { enabled: false });
    }
  }
}

describe('API -- Recurring', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  // ── POST /api/recurring ──────────────────────────────────────

  describe('POST /api/recurring', () => {
    it('creates a recurring config with cronExpression and returns 201', async () => {
      const res = await invoke('POST', '/api/recurring', {
        description: 'Weekly standup',
        cronExpression: '0 9 * * 3',
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.recurringConfig);
      assert.ok(body.recurringConfig.id);
      assert.strictEqual(body.recurringConfig.description, 'Weekly standup');
      assert.strictEqual(body.recurringConfig.cronExpression, '0 9 * * 3');
      assert.strictEqual(body.recurringConfig.enabled, true);
      assert.ok(body.recurringConfig.createdAt);
      assert.ok(body.recurringConfig.updatedAt);
      // Verify old fields are NOT present
      assert.strictEqual(body.recurringConfig.schedule, undefined);
      assert.strictEqual(body.recurringConfig.dayOfWeek, undefined);
      assert.strictEqual(body.recurringConfig.dayOfMonth, undefined);
    });

    it('creates a recurring config with assigneeId', async () => {
      const res = await invoke('POST', '/api/recurring', {
        description: 'Mailchimp dump',
        cronExpression: '0 10 * * 3',
        assigneeId: 'user-grace',
      });

      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.recurringConfig.assigneeId, 'user-grace');
      assert.strictEqual(body.recurringConfig.cronExpression, '0 10 * * 3');
    });

    it('returns 400 when description is missing', async () => {
      const res = await invoke('POST', '/api/recurring', {
        cronExpression: '0 9 * * *',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('description'));
    });

    it('returns 400 when cronExpression is missing', async () => {
      const res = await invoke('POST', '/api/recurring', {
        description: 'No cron',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('cronexpression'));
    });

    it('returns 400 for malformed cronExpression (not 5 fields)', async () => {
      const res = await invoke('POST', '/api/recurring', {
        description: 'Bad cron',
        cronExpression: 'every wednesday',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('cron'));
    });

    it('returns 400 for cronExpression with too few fields', async () => {
      const res = await invoke('POST', '/api/recurring', {
        description: 'Bad cron',
        cronExpression: '0 9 * *',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('cron'));
    });

    it('returns 400 for cronExpression with too many fields', async () => {
      const res = await invoke('POST', '/api/recurring', {
        description: 'Bad cron',
        cronExpression: '0 9 * * * *',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('cron'));
    });

    it('rejects old schedule field -- returns 400 requiring cronExpression', async () => {
      const res = await invoke('POST', '/api/recurring', {
        description: 'Old style',
        schedule: 'weekly',
        dayOfWeek: 3,
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('cronexpression'));
    });

    it('returns 400 for malformed JSON body', async () => {
      const res = await invoke('POST', '/api/recurring', 'not valid json{{');

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Invalid JSON');
    });
  });

  // ── GET /api/recurring ───────────────────────────────────────

  describe('GET /api/recurring', () => {
    it('returns 200 with an array of recurring configs', async () => {
      const res = await invoke('GET', '/api/recurring');

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers!['Content-Type'], 'application/json');

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.recurringConfigs));
      assert.ok(body.recurringConfigs.length > 0);
    });
  });

  // ── GET /api/recurring/:id ──────────────────────────────────

  describe('GET /api/recurring/:id', () => {
    it('returns 200 with the config for a valid id', async () => {
      const created = await createRecurringConfig(client, {
        description: 'Get test',
        cronExpression: '0 9 * * *',
      });

      const res = await invoke('GET', `/api/recurring/${created.id}`);
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(body.recurringConfig);
      assert.strictEqual(body.recurringConfig.id, created.id);
      assert.strictEqual(body.recurringConfig.description, 'Get test');
      assert.strictEqual(body.recurringConfig.cronExpression, '0 9 * * *');
    });

    it('returns 404 for a non-existent config', async () => {
      const res = await invoke('GET', '/api/recurring/does-not-exist');

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('not found'));
    });
  });

  // ── PUT /api/recurring/:id ──────────────────────────────────

  describe('PUT /api/recurring/:id', () => {
    it('updates cronExpression and returns 200', async () => {
      const created = await createRecurringConfig(client, {
        description: 'Update cron test',
        cronExpression: '0 9 * * 3',
      });

      const res = await invoke('PUT', `/api/recurring/${created.id}`, {
        cronExpression: '0 9 * * 1',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.recurringConfig.cronExpression, '0 9 * * 1');
    });

    it('updates assigneeId and returns 200', async () => {
      const created = await createRecurringConfig(client, {
        description: 'Update assignee test',
        cronExpression: '0 9 * * *',
      });

      const res = await invoke('PUT', `/api/recurring/${created.id}`, {
        assigneeId: 'user-valeriia',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.recurringConfig.assigneeId, 'user-valeriia');
    });

    it('updates description and enabled and returns 200', async () => {
      const created = await createRecurringConfig(client, {
        description: 'Old description',
        cronExpression: '0 9 * * *',
      });

      await new Promise((r) => setTimeout(r, 10));

      const res = await invoke('PUT', `/api/recurring/${created.id}`, {
        description: 'New description',
        enabled: false,
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.recurringConfig.description, 'New description');
      assert.strictEqual(body.recurringConfig.enabled, false);
      assert.ok(body.recurringConfig.updatedAt > created.updatedAt);
    });

    it('returns 400 for malformed cronExpression on update', async () => {
      const created = await createRecurringConfig(client, {
        description: 'Bad update test',
        cronExpression: '0 9 * * *',
      });

      const res = await invoke('PUT', `/api/recurring/${created.id}`, {
        cronExpression: 'not a cron',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('cron'));
    });

    it('returns 404 when updating a non-existent config', async () => {
      const res = await invoke('PUT', '/api/recurring/does-not-exist', {
        description: 'New',
      });

      assert.strictEqual(res.statusCode, 404);
    });

    it('returns 400 when body is empty', async () => {
      const created = await createRecurringConfig(client, {
        description: 'Test',
        cronExpression: '0 9 * * *',
      });

      const res = await invoke('PUT', `/api/recurring/${created.id}`, {});
      assert.strictEqual(res.statusCode, 400);
    });

    it('returns 400 when body has no valid fields', async () => {
      const created = await createRecurringConfig(client, {
        description: 'Test',
        cronExpression: '0 9 * * *',
      });

      const res = await invoke('PUT', `/api/recurring/${created.id}`, {
        unknownField: 'value',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.toLowerCase().includes('no valid fields'));
    });

    it('returns 400 for malformed JSON', async () => {
      const created = await createRecurringConfig(client, {
        description: 'Test',
        cronExpression: '0 9 * * *',
      });

      const res = await invoke('PUT', `/api/recurring/${created.id}`, 'bad json');
      assert.strictEqual(res.statusCode, 400);
    });
  });

  // ── DELETE /api/recurring/:id ───────────────────────────────

  describe('DELETE /api/recurring/:id', () => {
    it('deletes an existing config and returns 204', async () => {
      const created = await createRecurringConfig(client, {
        description: 'Delete me',
        cronExpression: '0 9 * * *',
      });

      const res = await invoke('DELETE', `/api/recurring/${created.id}`);
      assert.strictEqual(res.statusCode, 204);

      const getRes = await invoke('GET', `/api/recurring/${created.id}`);
      assert.strictEqual(getRes.statusCode, 404);
    });

    it('returns 404 when deleting a non-existent config', async () => {
      const res = await invoke('DELETE', '/api/recurring/does-not-exist');
      assert.strictEqual(res.statusCode, 404);
    });
  });

  // ── POST /api/recurring/generate ────────────────────────────

  describe('POST /api/recurring/generate', () => {
    it('generates daily tasks for the given range (cron: 0 9 * * *)', async () => {
      await disableAllConfigs(client);

      await createRecurringConfig(client, {
        description: 'API gen standup',
        cronExpression: '0 9 * * *',
      });

      const res = await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-01-02',
        endDate: '2028-01-04',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.generated.length, 3);
      assert.strictEqual(body.skipped, 0);

      for (const task of body.generated) {
        assert.strictEqual(task.source, 'recurring');
        assert.strictEqual(task.status, 'todo');
        assert.strictEqual(task.description, 'API gen standup');
      }
    });

    it('is idempotent -- second call skips existing tasks', async () => {
      const res = await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-01-02',
        endDate: '2028-01-04',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.generated.length, 0);
      assert.strictEqual(body.skipped, 3);
    });

    it('generates weekly tasks only on matching day-of-week (cron: 0 9 * * 3)', async () => {
      await disableAllConfigs(client);

      await createRecurringConfig(client, {
        description: 'API gen wednesday',
        cronExpression: '0 9 * * 3',
      });

      const res = await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-02-01',
        endDate: '2028-02-14',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.generated.length, 2);
      const dates = body.generated.map((t: any) => t.date).sort();
      assert.deepStrictEqual(dates, ['2028-02-02', '2028-02-09']);
    });

    it('generates monthly tasks only on matching day-of-month (cron: 0 9 15 * *)', async () => {
      await disableAllConfigs(client);

      await createRecurringConfig(client, {
        description: 'API gen monthly report',
        cronExpression: '0 9 15 * *',
      });

      const res = await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-06-01',
        endDate: '2028-08-30',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.generated.length, 3);
      const dates = body.generated.map((t: any) => t.date).sort();
      assert.deepStrictEqual(dates, ['2028-06-15', '2028-07-15', '2028-08-15']);
    });

    it('generated tasks inherit assigneeId from config', async () => {
      await disableAllConfigs(client);

      await createRecurringConfig(client, {
        description: 'API gen with assignee',
        cronExpression: '0 9 * * *',
        assigneeId: 'user-grace',
      });

      const res = await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-05-01',
        endDate: '2028-05-01',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.generated.length, 1);
      assert.strictEqual(body.generated[0].assigneeId, 'user-grace');
    });

    it('skips disabled configs', async () => {
      await disableAllConfigs(client);

      await createRecurringConfig(client, {
        description: 'API gen disabled',
        cronExpression: '0 9 * * *',
        enabled: false,
      });

      const res = await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-04-02',
        endDate: '2028-04-04',
      });

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.generated.length, 0);
      assert.strictEqual(body.skipped, 0);
    });

    it('returns 400 when startDate is missing', async () => {
      const res = await invoke('POST', '/api/recurring/generate', {
        endDate: '2028-03-04',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('startDate'));
    });

    it('returns 400 when endDate is missing', async () => {
      const res = await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-03-02',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('endDate'));
    });

    it('returns 400 when date range exceeds 90 days', async () => {
      const res = await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-01-01',
        endDate: '2028-06-01',
      });

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('90 days'));
    });

    it('returns 400 when endDate is before startDate', async () => {
      const res = await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-03-10',
        endDate: '2028-03-01',
      });

      assert.strictEqual(res.statusCode, 400);
    });

    it('returns 400 for invalid JSON body', async () => {
      const res = await invoke('POST', '/api/recurring/generate', 'not json{{');

      assert.strictEqual(res.statusCode, 400);
    });

    it('generated tasks are visible via normal task queries', async () => {
      await disableAllConfigs(client);

      await createRecurringConfig(client, {
        description: 'API visible standup',
        cronExpression: '0 9 * * *',
      });

      await invoke('POST', '/api/recurring/generate', {
        startDate: '2028-09-02',
        endDate: '2028-09-02',
      });

      const taskRes = await handler(
        {
          httpMethod: 'GET',
          path: '/api/tasks',
          body: null,
          queryStringParameters: { date: '2028-09-02' },
        },
        {}
      );

      assert.strictEqual(taskRes.statusCode, 200);
      const taskBody = JSON.parse(taskRes.body);
      const recurringTasks = taskBody.tasks.filter((t: any) => t.source === 'recurring');
      assert.ok(recurringTasks.length >= 1);
      assert.strictEqual(recurringTasks[0].description, 'API visible standup');
    });
  });

  // ── Method not allowed ──────────────────────────────────────

  describe('Method not allowed', () => {
    it('returns 405 for PATCH /api/recurring', async () => {
      const res = await invoke('PATCH', '/api/recurring');
      assert.strictEqual(res.statusCode, 405);
    });

    it('returns 405 for GET /api/recurring/generate', async () => {
      const res = await invoke('GET', '/api/recurring/generate');
      assert.strictEqual(res.statusCode, 405);
    });
  });

  // ── Content-Type header ─────────────────────────────────────

  describe('Content-Type header', () => {
    it('all API responses include Content-Type: application/json', async () => {
      const res200 = await invoke('GET', '/api/recurring');
      assert.strictEqual(res200.headers!['Content-Type'], 'application/json');

      const res404 = await invoke('GET', '/api/recurring/nonexistent');
      assert.strictEqual(res404.headers!['Content-Type'], 'application/json');

      const res201 = await invoke('POST', '/api/recurring', {
        description: 'CT Test',
        cronExpression: '0 9 * * *',
      });
      assert.strictEqual(res201.headers!['Content-Type'], 'application/json');

      const res405 = await invoke('PATCH', '/api/recurring');
      assert.strictEqual(res405.headers!['Content-Type'], 'application/json');
    });
  });
});
