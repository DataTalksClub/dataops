import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables, deleteTables } from '../scripts/local-dynamodb';
import { createTemplate } from '../src/db/templates';
import { createCard, getCard } from '../src/db/cards';
import { EMPTY_TEMPLATE_ID, putEmptyTemplate, templateLink } from './helpers/cardTemplate';
import { createTask, getTask } from '../src/db/tasks';
import type { LambdaResponse } from '../src/types';

describe('API — CRUD for tasks', () => {
  let port: number;
  let handler: typeof import('../src/handler').handler;

  before(async () => {
    port = await startLocal();
    await createTables(await getClient(port));
    await putEmptyTemplate(await getClient(port));
    process.env.IS_LOCAL = 'true';

    const mod = await import('../src/handler');
    handler = mod.handler;

    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  // ── POST /api/tasks ────────────────────────────────────────────────

  describe('POST /api/tasks', () => {
    it('creates a task with required fields and returns 201', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Review draft', date: '2026-03-10' }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 201);

      const body = JSON.parse(res.body);
      assert.ok(body.id);
      assert.strictEqual(body.description, 'Review draft');
      assert.strictEqual(body.date, '2026-03-10');
      assert.strictEqual(body.status, 'todo');
      assert.strictEqual(body.version, 1);
      assert.deepStrictEqual(body.taskHistory, []);
      assert.ok(body.createdAt);
      assert.ok(body.updatedAt);
    });

    it('creates a task with optional fields', async () => {
      const card = await createCard(await getClient(port), {
        ...templateLink(),
        title: 'Optional Task Card',
        anchorDate: '2026-03-10',
      });
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Review draft',
          date: '2026-03-10',
          comment: 'Important',
          cardId: card.id,
          source: 'telegram',
        }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 201);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.comment, 'Important');
      assert.strictEqual(body.cardId, card.id);
      assert.strictEqual(body.source, 'telegram');
    });

    it('creates a waiting task with follow-up metadata', async () => {
      const card = await createCard(await getClient(port), {
        ...templateLink(),
        title: 'Initially waiting Task Card',
        anchorDate: '2026-03-10',
      });
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        headers: { 'x-user-id': 'waiting-operator' },
        body: JSON.stringify({
          description: 'Wait for speaker confirmation',
          date: '2026-03-10',
          cardId: card.id,
          status: 'waiting',
          waitingFor: 'Speaker reply',
          followUpAt: '2026-03-12T09:00:00.000Z',
          comment: 'Waiting for speaker confirmation',
        }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 201);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.status, 'waiting');
      assert.strictEqual(body.waitingFor, 'Speaker reply');
      assert.strictEqual(body.followUpAt, '2026-03-12T09:00:00.000Z');
      assert.strictEqual(body.comment, 'Waiting for speaker confirmation');
      assert.strictEqual(body.version, 1);
      assert.strictEqual(body.taskHistory.length, 1);
      assert.strictEqual(body.taskHistory[0].action, 'waiting-started');
      assert.strictEqual(body.taskHistory[0].actorId, 'waiting-operator');
      assert.strictEqual(body.taskHistory[0].taskId, body.id);
      assert.strictEqual(body.taskHistory[0].cardId, card.id);

      const currentCard = await getCard(await getClient(port), card.id);
      assert.deepStrictEqual(
        { taskCount: currentCard?.taskCount, openTaskCount: currentCard?.openTaskCount, status: currentCard?.status },
        { taskCount: 1, openTaskCount: 1, status: 'active' },
      );

      const getRes = await handler({ httpMethod: 'GET', path: `/api/tasks/${body.id}` }, {});
      assert.strictEqual(getRes.statusCode, 200);
      const fetched = JSON.parse(getRes.body);
      assert.strictEqual(fetched.waitingFor, 'Speaker reply');
      assert.strictEqual(fetched.followUpAt, '2026-03-12T09:00:00.000Z');
      assert.strictEqual(fetched.comment, 'Waiting for speaker confirmation');
    });

    it('creates an attached done Task with completion history and archives the Card atomically', async () => {
      const card = await createCard(await getClient(port), {
        ...templateLink(),
        title: 'Initially completed Task Card',
        anchorDate: '2026-03-10',
        stage: 'announced',
      });
      const res = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        headers: { 'x-user-id': 'completion-operator' },
        body: JSON.stringify({
          description: 'Already completed work',
          date: '2026-03-10',
          cardId: card.id,
          status: 'done',
        }),
      }, {});
      assert.strictEqual(res.statusCode, 201, res.body);
      const task = JSON.parse(res.body);
      assert.strictEqual(task.version, 1);
      assert.strictEqual(task.completedBy, 'completion-operator');
      assert.ok(task.completedAt);
      assert.strictEqual(task.taskHistory.length, 1);
      assert.strictEqual(task.taskHistory[0].action, 'completed');
      assert.strictEqual(task.taskHistory[0].actorId, 'completion-operator');
      assert.strictEqual(task.taskHistory[0].createdAt, task.completedAt);

      const currentCard = await getCard(await getClient(port), card.id);
      assert.deepStrictEqual(
        {
          taskCount: currentCard?.taskCount,
          openTaskCount: currentCard?.openTaskCount,
          status: currentCard?.status,
          stage: currentCard?.stage,
          completedBy: currentCard?.completedBy,
          activeStageBeforeCompletion: currentCard?.activeStageBeforeCompletion,
        },
        {
          taskCount: 1,
          openTaskCount: 0,
          status: 'archived',
          stage: 'done',
          completedBy: 'completion-operator',
          activeStageBeforeCompletion: 'announced',
        },
      );
      assert.strictEqual(currentCard?.completedAt, task.completedAt);
    });

    it('rejects creating a Task already skipped, which needs the reasoned skip action', async () => {
      const res = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Cannot start skipped',
          date: '2026-03-10',
          status: 'skipped',
        }),
      }, {});
      assert.strictEqual(res.statusCode, 400, res.body);
      assert.strictEqual(JSON.parse(res.body).error, 'skipped is set with the skip action, which requires a reason');
    });

    it('returns the strongly current Card when attached Task creation loses the Card condition', async () => {
      const { route } = await import('../src/router');
      const initialCard = {
        ...templateLink(),
        id: 'create-conflict-card', version: 4, title: 'Initial Card',
        status: 'active', stage: 'preparation', taskCount: 1, openTaskCount: 1,
        createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
      };
      const currentCard = {
        ...initialCard, version: 5, title: 'Current Card', updatedAt: '2026-03-02T00:00:00.000Z',
      };
      let cardReads = 0;
      const fake = {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            throw Object.assign(new Error('Card raced'), { name: 'TransactionCanceledException' });
          }
          if (!(command instanceof GetCommand)) throw new Error('Unexpected command');
          if (command.input.TableName === 'Tasks') return {};
          if (command.input.TableName === 'Projects') {
            cardReads += 1;
            return { Item: { PK: 'CARD#create-conflict-card', SK: 'CARD#create-conflict-card', ...(cardReads === 1 ? initialCard : currentCard) } };
          }
          return {};
        },
      } as any;
      const response = await route({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Losing attached creation',
          date: '2026-03-10',
          cardId: initialCard.id,
        }),
      }, fake);
      assert.strictEqual(response.statusCode, 409, response.body);
      assert.deepStrictEqual(JSON.parse(response.body), {
        error: 'Card or its Tasks changed; review current work and retry',
        code: 'card_lifecycle_conflict',
        currentCard,
      });
      assert.ok(cardReads >= 3);
    });

    it('returns 400 when creating a waiting task without follow-up metadata', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Blocked task',
          date: '2026-03-10',
          status: 'waiting',
          waitingFor: 'External reply',
        }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Waiting tasks require waitingFor, followUpAt, and comment');
    });

    it('returns 400 when waiting metadata is blank', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Blank waiting fields',
          date: '2026-03-10',
          status: 'waiting',
          waitingFor: '   ',
          followUpAt: '2026-03-12T09:00:00.000Z',
          comment: 'Has note',
        }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Waiting tasks require waitingFor, followUpAt, and comment');
    });

    it('returns 400 when description is missing', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ date: '2026-03-10' }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Missing required field: description');
    });

    it('returns 400 when date is missing', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Review draft' }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Missing required field: date');
    });

    it('returns 400 when body is invalid JSON', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: 'not-json',
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.ok(body.error);
    });

    it('returns 400 when body is null', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: null,
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 400);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Request body is required');
    });
  });

  // ── GET /api/tasks (list with filters) ─────────────────────────────

  describe('GET /api/tasks', () => {
    it('lists every task without repeating large frozen definitions and preserves full detail', async () => {
      const date = '2099-04-19';
      const snapshot = {
        description: 'Reviewed definition '.repeat(17_000),
        date, templateOffsetDays: 0, templateTaskOrder: 0,
      };
      const created = [];
      for (let index = 0; index < 20; index++) {
        created.push(await createTask(await getClient(port), {
          description: `Payload regression ${index}`, date,
          templateDefinitionSnapshot: snapshot,
          sourceDocIds: ['sop.synthetic.review'],
          comment: 'Keep the actual task evidence',
        }));
      }
      assert.ok(Buffer.byteLength(JSON.stringify(created)) > 6_291_456,
        'fixture must reproduce the Lambda response-size failure');
      const response = await handler({ httpMethod: 'GET', path: '/api/tasks',
        queryStringParameters: { date } }, {});
      assert.equal(response.statusCode, 200);
      const tasks = JSON.parse(response.body).tasks;
      assert.deepEqual(new Set(tasks.map((task: { id: string }) => task.id)),
        new Set(created.map(task => task.id)), 'no rows silently dropped');
      assert.ok(Buffer.byteLength(response.body) < 100_000);
      for (const task of tasks) {
        assert.equal(Object.hasOwn(task, 'templateDefinitionSnapshot'), false);
        assert.deepEqual(task.taskHistory, []);
        assert.deepEqual(task.sourceDocIds, ['sop.synthetic.review']);
        assert.equal(task.comment, 'Keep the actual task evidence');
      }
      const detail = await handler({ httpMethod: 'GET', path: `/api/tasks/${created[0].id}` }, {});
      assert.equal(detail.statusCode, 200);
      assert.deepEqual(JSON.parse(detail.body).templateDefinitionSnapshot, snapshot);
      assert.deepEqual((await getTask(await getClient(port), created[0].id))!.templateDefinitionSnapshot,
        snapshot, 'listing must not alter persisted provenance');
    });

    it('intersects date, range, card and status filters', async () => {
      const client = await getClient(port);
      const card = await createCard(client, { ...templateLink(), title: 'Combined filters', anchorDate: '2099-02-10' });
      const other = await createCard(client, { ...templateLink(), title: 'Other combined filters', anchorDate: '2099-02-10' });
      const target = await createTask(client, { description: 'Matching task', date: '2099-02-10', cardId: card.id });
      await createTask(client, { description: 'Wrong card', date: '2099-02-10', cardId: other.id });
      await createTask(client, { description: 'Wrong date', date: '2099-02-11', cardId: card.id });
      await createTask(client, { description: 'Already done', date: '2099-02-10', cardId: card.id, status: 'done' });
      for (const primary of [
        { date: '2099-02-10' },
        { startDate: '2099-02-10', endDate: '2099-02-10' },
      ]) {
        const response = await handler({
          httpMethod: 'GET', path: '/api/tasks',
          queryStringParameters: { ...primary, cardId: card.id, status: 'todo' },
        }, {});
        assert.strictEqual(response.statusCode, 200, response.body);
        assert.deepStrictEqual(JSON.parse(response.body).tasks.map((task: { id: string }) => task.id), [target.id]);
      }
      const contradictory = await handler({
        httpMethod: 'GET', path: '/api/tasks',
        queryStringParameters: { date: '2099-02-10', startDate: '2099-02-11', endDate: '2099-02-12' },
      }, {});
      assert.deepStrictEqual(JSON.parse(contradictory.body).tasks, []);
    });

    it('validates secondary filters even when a date selects the query', async () => {
      for (const secondary of [{ status: 'invalid' }, { startDate: '2099-02-10' }]) {
        const response = await handler({
          httpMethod: 'GET', path: '/api/tasks',
          queryStringParameters: { date: '2099-02-10', ...secondary },
        }, {});
        assert.strictEqual(response.statusCode, 400, response.body);
      }
    });

    it('returns tasks filtered by date', async () => {
      const uniqueDate = '2090-07-15';
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'D1', date: uniqueDate }),
      }, {});
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'D2', date: uniqueDate }),
      }, {});
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'D3', date: '2090-07-16' }),
      }, {});

      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { date: uniqueDate },
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.tasks.length, 2);
      for (const task of body.tasks) {
        assert.strictEqual(task.date, uniqueDate);
      }
    });

    it('returns tasks filtered by date range', async () => {
      const d1 = '2091-06-01';
      const d2 = '2091-06-03';
      const d3 = '2091-06-05';
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'R1', date: d1 }),
      }, {});
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'R2', date: d2 }),
      }, {});
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'R3', date: d3 }),
      }, {});

      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { startDate: '2091-06-02', endDate: '2091-06-04' },
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.tasks.length, 1);
      assert.strictEqual(body.tasks[0].description, 'R2');
    });

    it('returns tasks filtered by cardId', async () => {
      const bid = (await createCard(await getClient(port), {
        ...templateLink(),
        title: 'Filter Card', anchorDate: '2092-01-01',
      })).id;
      const other = (await createCard(await getClient(port), {
        ...templateLink(),
        title: 'Other Filter Card', anchorDate: '2092-01-01',
      })).id;
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'P1', date: '2092-01-01', cardId: bid }),
      }, {});
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'P2', date: '2092-01-02', cardId: bid }),
      }, {});
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'P3', date: '2092-01-01', cardId: other }),
      }, {});

      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { cardId: bid },
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.tasks.length, 2);
      for (const task of body.tasks) {
        assert.strictEqual(task.cardId, bid);
      }
    });

    it('returns tasks for several cards in one cardIds request', async () => {
      const first = (await createCard(await getClient(port), {
        ...templateLink(),
        title: 'Batch Card One', anchorDate: '2092-02-01',
      })).id;
      const second = (await createCard(await getClient(port), {
        ...templateLink(),
        title: 'Batch Card Two', anchorDate: '2092-02-01',
      })).id;
      const third = (await createCard(await getClient(port), {
        ...templateLink(),
        title: 'Batch Card Three', anchorDate: '2092-02-01',
      })).id;
      for (const [cardId, description] of [[first, 'B1'], [second, 'B2'], [third, 'B3']]) {
        await handler({
          httpMethod: 'POST', path: '/api/tasks',
          body: JSON.stringify({ description, date: '2092-02-01', cardId }),
        }, {});
      }

      const batched = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { cardIds: `${first},${second}` },
      }, {});

      assert.strictEqual(batched.statusCode, 200);
      const batchedBody = JSON.parse(batched.body);
      assert.strictEqual(batchedBody.tasks.length, 2);
      assert.deepStrictEqual(
        batchedBody.tasks.map((task) => task.cardId).sort(),
        [first, second].sort(),
      );

      const rejected = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { cardIds: `${first},${second}`, cardId: first },
      }, {});
      assert.strictEqual(rejected.statusCode, 400);

      const empty = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { cardIds: '  ' },
      }, {});
      assert.strictEqual(empty.statusCode, 400);
    });

    it('returns tasks filtered by status', async () => {
      const uniqueDate = '2093-09-09';
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'S1', date: uniqueDate }),
      }, {});
      await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'S2', date: uniqueDate }),
      }, {});
      const createRes = await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'S3', date: uniqueDate }),
      }, {});
      const s3 = JSON.parse(createRes.body);
      await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${s3.id}`,
        body: JSON.stringify({ status: 'done' }),
      }, {});

      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { status: 'todo' },
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.tasks.length >= 2);
      for (const task of body.tasks) {
        assert.strictEqual(task.status, 'todo');
      }
    });

    it('returns tasks filtered by waiting status', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Waiting filter target',
          date: '2093-09-10',
          status: 'waiting',
          waitingFor: 'Partner approval',
          followUpAt: '2093-09-12T09:00:00.000Z',
          comment: 'Waiting for partner approval',
        }),
      }, {});
      assert.strictEqual(createRes.statusCode, 201);
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { status: 'waiting' },
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const found = body.tasks.find((task: any) => task.id === created.id);
      assert.ok(found, 'Waiting task should appear in waiting status results');
      assert.strictEqual(found.status, 'waiting');
      assert.strictEqual(found.waitingFor, 'Partner approval');
      assert.strictEqual(found.followUpAt, '2093-09-12T09:00:00.000Z');
    });

    it('returns 400 when no query parameters provided', async () => {
      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: null,
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('At least one filter is required'), body.error);
    });

    it('returns 400 when empty queryStringParameters object', async () => {
      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: {},
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('At least one filter is required'), body.error);
    });

    it('returns 400 when startDate provided without endDate', async () => {
      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { startDate: '2026-03-01' },
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Both startDate and endDate are required for range queries');
    });

    it('returns 400 when endDate provided without startDate', async () => {
      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { endDate: '2026-03-31' },
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Both startDate and endDate are required for range queries');
    });

    it('returns 400 when status is invalid', async () => {
      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { status: 'invalid' },
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, "Invalid status. Must be 'todo', 'waiting', 'done', or 'skipped'");
    });
  });

  // ── Browser requirement ────────────────────────────────────────────

  describe('browser requirement', () => {
    const browserDate = '2098-06-01';

    it('creates a Task carrying an explicit browser requirement and rejects unknown values', async () => {
      const createRes = await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'Headless refresh', date: browserDate, browserRequirement: 'headless' }),
      }, {});
      assert.strictEqual(createRes.statusCode, 201, createRes.body);
      const created = JSON.parse(createRes.body);
      assert.strictEqual(created.browserRequirement, 'headless');
      assert.strictEqual((await getTask(await getClient(port), created.id))!.browserRequirement, 'headless');

      for (const invalid of ['unknown', true, 'none']) {
        const bad = await handler({
          httpMethod: 'POST', path: '/api/tasks',
          body: JSON.stringify({ description: 'Bad classification', date: browserDate, browserRequirement: invalid }),
        }, {});
        assert.strictEqual(bad.statusCode, 400, String(invalid));
        assert.match(JSON.parse(bad.body).error, /browserRequirement must be/);
      }
    });

    it('creates a Task with no browser requirement and reads it back unclassified', async () => {
      const createRes = await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'Not classified yet', date: browserDate }),
      }, {});
      const created = JSON.parse(createRes.body);
      assert.strictEqual(created.browserRequirement, undefined);
      const detail = await handler({ httpMethod: 'GET', path: `/api/tasks/${created.id}` }, {});
      assert.strictEqual(JSON.parse(detail.body).browserRequirement, undefined);
    });

    it('updates and clears the classification as a versioned field write', async () => {
      const createRes = await handler({
        httpMethod: 'POST', path: '/api/tasks',
        body: JSON.stringify({ description: 'Classify me', date: browserDate }),
      }, {});
      const created = JSON.parse(createRes.body);

      const setRes = await handler({
        httpMethod: 'PUT', path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ browserRequirement: 'required', expectedVersion: created.version }),
      }, {});
      assert.strictEqual(setRes.statusCode, 200, setRes.body);
      const set = JSON.parse(setRes.body);
      assert.strictEqual(set.browserRequirement, 'required');
      assert.strictEqual(set.version, created.version + 1);

      const clearRes = await handler({
        httpMethod: 'PUT', path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ browserRequirement: null, expectedVersion: set.version }),
      }, {});
      assert.strictEqual(clearRes.statusCode, 200, clearRes.body);
      const cleared = JSON.parse(clearRes.body);
      assert.strictEqual(cleared.browserRequirement, undefined);
      assert.strictEqual(cleared.version, set.version + 1);
    });

    it('keeps unclassified Tasks out of headless mode and never mutates them by filtering', async () => {
      const client = await getClient(port);
      const filterDate = '2098-06-02';
      const headless = await createTask(client, {
        description: 'Headless only', date: filterDate, browserRequirement: 'headless',
      });
      const required = await createTask(client, {
        description: 'Needs the browser', date: filterDate, browserRequirement: 'required',
      });
      const unclassified = await createTask(client, { description: 'Undecided work', date: filterDate });

      const headlessList = await handler({
        httpMethod: 'GET', path: '/api/tasks',
        queryStringParameters: { date: filterDate, browser: 'headless' },
      }, {});
      assert.strictEqual(headlessList.statusCode, 200, headlessList.body);
      assert.deepStrictEqual(
        JSON.parse(headlessList.body).tasks.map((task: { id: string }) => task.id),
        [headless.id],
        'headless mode keeps only explicitly classified Tasks',
      );

      const requiredList = await handler({
        httpMethod: 'GET', path: '/api/tasks',
        queryStringParameters: { date: filterDate, browser: 'required' },
      }, {});
      assert.deepStrictEqual(
        JSON.parse(requiredList.body).tasks.map((task: { id: string }) => task.id),
        [required.id],
      );

      const unclassifiedList = await handler({
        httpMethod: 'GET', path: '/api/tasks',
        queryStringParameters: { date: filterDate, browser: 'unclassified' },
      }, {});
      assert.deepStrictEqual(
        JSON.parse(unclassifiedList.body).tasks.map((task: { id: string }) => task.id),
        [unclassified.id],
      );

      const unfiltered = await handler({
        httpMethod: 'GET', path: '/api/tasks',
        queryStringParameters: { date: filterDate },
      }, {});
      assert.strictEqual(JSON.parse(unfiltered.body).tasks.length, 3);

      // Filtering is a read: status, due dates, and versions are untouched.
      for (const task of [headless, required, unclassified]) {
        const stored = await getTask(client, task.id);
        assert.strictEqual(stored!.status, 'todo');
        assert.strictEqual(stored!.date, filterDate);
        assert.strictEqual(stored!.version, 1);
      }
    });

    it('composes the browser filter with owner and status and validates its value', async () => {
      const client = await getClient(port);
      const mine = await createTask(client, {
        description: 'My headless work', date: browserDate,
        assigneeId: 'browser-operator', browserRequirement: 'headless',
      });
      await createTask(client, {
        description: 'Their headless work', date: browserDate,
        assigneeId: 'other-operator', browserRequirement: 'headless',
      });
      await createTask(client, {
        description: 'My browser work', date: browserDate,
        assigneeId: 'browser-operator', browserRequirement: 'required',
      });

      const composed = await handler({
        httpMethod: 'GET', path: '/api/tasks',
        queryStringParameters: { date: browserDate, owner: 'browser-operator', browser: 'headless', status: 'todo' },
      }, {});
      assert.strictEqual(composed.statusCode, 200, composed.body);
      assert.deepStrictEqual(
        JSON.parse(composed.body).tasks.map((task: { id: string }) => task.id),
        [mine.id],
      );

      for (const browser of ['maybe', '']) {
        const bad = await handler({
          httpMethod: 'GET', path: '/api/tasks',
          queryStringParameters: { date: browserDate, browser },
        }, {});
        assert.strictEqual(bad.statusCode, 400, browser);
        assert.match(JSON.parse(bad.body).error, /browser must be one of/);
      }
    });
  });

  // ── GET /api/tasks/:id ─────────────────────────────────────────────

  describe('GET /api/tasks/:id', () => {
    it('returns a task by id', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Get me', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'GET',
        path: `/api/tasks/${created.id}`,
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.id, created.id);
      assert.strictEqual(body.description, 'Get me');
    });

    it('returns 404 for a nonexistent task', async () => {
      const res = await handler({
        httpMethod: 'GET',
        path: '/api/tasks/nonexistent-id-999',
      }, {});

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Task not found');
    });
  });

  // ── PUT /api/tasks/:id ─────────────────────────────────────────────

  describe('PUT /api/tasks/:id', () => {
    it('requires only expectedVersion as the write precondition', async () => {
      const created = JSON.parse((await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Precondition task', date: '2026-03-10' }),
      }, {})).body);

      for (const invalidBody of [
        { status: 'done' },
        { status: 'done', expectedVersion: 0 },
        { status: 'done', expectedVersion: 1.5 },
        { status: 'done', expectedVersion: '1' },
        { status: 'done', version: created.version },
        { status: 'done', version: created.version, expectedVersion: created.version },
      ]) {
        const response = await handler({
          httpMethod: 'PUT',
          path: `/api/tasks/${created.id}`,
          body: JSON.stringify(invalidBody),
        }, {});
        assert.strictEqual(response.statusCode, 400, JSON.stringify(invalidBody));
      }

      const unchanged = JSON.parse((await handler({
        httpMethod: 'GET',
        path: `/api/tasks/${created.id}`,
      }, {})).body);
      assert.strictEqual(unchanged.version, 1);
      assert.strictEqual(unchanged.status, 'todo');
      assert.deepStrictEqual(unchanged.taskHistory, []);
    });

    it('requires expectedVersion for every Task action', async () => {
      const created = JSON.parse((await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Action preconditions', date: '2026-03-10' }),
      }, {})).body);
      for (const action of ['mark-waiting', 'follow-up-sent', 'response-received', 'unblocked', 'resolve-done']) {
        const response = await handler({
          httpMethod: 'POST',
          path: `/api/tasks/${created.id}/actions/${action}`,
          body: JSON.stringify({}),
        }, {});
        assert.strictEqual(response.statusCode, 400, action);
        assert.strictEqual(JSON.parse(response.body).error, 'expectedVersion is required');
      }
    });

    it('returns one winner and a canonical currentTask to a concurrent loser', async () => {
      const created = JSON.parse((await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Concurrent API task', date: '2026-03-10' }),
      }, {})).body);

      const [left, right] = await Promise.all([
        handler({
          httpMethod: 'PUT',
          path: `/api/tasks/${created.id}`,
          body: JSON.stringify({ comment: 'left', expectedVersion: created.version }),
        }, {}),
        handler({
          httpMethod: 'PUT',
          path: `/api/tasks/${created.id}`,
          body: JSON.stringify({ comment: 'right', expectedVersion: created.version }),
        }, {}),
      ]);
      const winner = [left, right].find((response) => response.statusCode === 200);
      const loser = [left, right].find((response) => response.statusCode === 409);
      assert.ok(winner);
      assert.ok(loser);
      const winnerTask = JSON.parse(winner.body);
      const conflict = JSON.parse(loser.body);
      assert.strictEqual(winnerTask.version, 2);
      assert.deepStrictEqual(conflict, {
        error: 'Task changed; review the current task and retry',
        code: 'task_version_conflict',
        expectedVersion: 1,
        currentVersion: 2,
        currentTask: winnerTask,
      });
      assert.strictEqual(conflict.currentTask.PK, undefined);
      assert.strictEqual(conflict.currentTask.SK, undefined);
      assert.ok(['left', 'right'].includes(winnerTask.comment));
    });

    it('returns canonical Task and Card snapshots for an aggregate conflict and succeeds on retry', async () => {
      const card = await createCard(await getClient(port), {
        ...templateLink(),
        title: 'Aggregate API conflict',
        anchorDate: '2026-03-10',
      });
      const tasks = [];
      for (const description of ['First final task', 'Second final task']) {
        const response = await handler({
          httpMethod: 'POST',
          path: '/api/tasks',
          body: JSON.stringify({ description, date: '2026-03-10', cardId: card.id }),
        }, {});
        assert.strictEqual(response.statusCode, 201, response.body);
        tasks.push(JSON.parse(response.body));
      }

      const results = await Promise.all(tasks.map((task) => handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${task.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: task.version }),
      }, {})));
      const winner = results.find(({ statusCode }) => statusCode === 200);
      const loser = results.find(({ statusCode }) => statusCode === 409);
      assert.ok(winner);
      assert.ok(loser);
      const conflict = JSON.parse(loser.body);
      assert.strictEqual(conflict.code, 'card_lifecycle_conflict');
      assert.strictEqual(conflict.currentTask.version, 1);
      assert.strictEqual(conflict.currentTask.status, 'todo');
      assert.strictEqual(conflict.currentCard.taskCount, 2);
      assert.strictEqual(conflict.currentCard.openTaskCount, 1);
      assert.strictEqual(conflict.currentCard.status, 'active');

      const retried = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${conflict.currentTask.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: conflict.currentTask.version }),
      }, {});
      assert.strictEqual(retried.statusCode, 200, retried.body);
      const currentCard = JSON.parse((await handler({
        httpMethod: 'GET',
        path: `/api/cards/${card.id}`,
      }, {})).body).card;
      assert.deepStrictEqual(
        { taskCount: currentCard.taskCount, openTaskCount: currentCard.openTaskCount, stage: currentCard.stage, status: currentCard.status },
        { taskCount: 2, openTaskCount: 0, stage: 'done', status: 'archived' },
      );
    });

    it('strongly reads Task validation state before PUT and action conditions', async () => {
      const { route } = await import('../src/router');
      const current = {
        id: 'strong-validation-task',
        version: 4,
        taskHistory: [],
        description: 'Strong validation read',
        date: '2026-03-10',
        status: 'todo',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      };
      const cases = [
        {
          path: `/api/tasks/${current.id}`,
          method: 'PUT',
          body: { comment: 'accepted', expectedVersion: current.version },
          next: { ...current, version: 5, comment: 'accepted' },
        },
        {
          path: `/api/tasks/${current.id}/actions/mark-waiting`,
          method: 'POST',
          body: {
            waitingFor: 'Reviewer',
            followUpAt: '2026-03-12',
            channel: 'portal',
            note: 'Waiting for review',
            expectedVersion: current.version,
          },
          next: {
            ...current,
            version: 5,
            status: 'waiting',
            waitingFor: 'Reviewer',
            followUpAt: '2026-03-12',
            taskHistory: [{
              id: 'history-strong-validation',
              taskId: current.id,
              action: 'waiting-started',
              createdAt: '2026-03-01T00:00:01.000Z',
            }],
          },
        },
      ];

      for (const testCase of cases) {
        const validationReads: Array<boolean | undefined> = [];
        let updates = 0;
        const fakeClient = {
          send: async (command: unknown) => {
            if (command instanceof GetCommand) {
              validationReads.push(command.input.ConsistentRead);
              const task = command.input.ConsistentRead
                ? current
                : { ...current, version: current.version + 1 };
              return { Item: { PK: `TASK#${current.id}`, SK: `TASK#${current.id}`, ...task } };
            }
            if (command instanceof UpdateCommand) {
              updates += 1;
              return { Attributes: { PK: `TASK#${current.id}`, SK: `TASK#${current.id}`, ...testCase.next } };
            }
            throw new Error(`Unexpected command ${(command as { constructor?: { name?: string } }).constructor?.name}`);
          },
        };

        const response = await route({
          httpMethod: testCase.method,
          path: testCase.path,
          body: JSON.stringify(testCase.body),
        }, fakeClient as any);

        assert.strictEqual(response.statusCode, 200, `${testCase.method} ${response.body}`);
        assert.deepStrictEqual(validationReads, [true]);
        assert.strictEqual(updates, 1);
      }
    });

    it('returns task_not_found when a stale write follows a conditional delete', async () => {
      const created = JSON.parse((await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Delete race', date: '2026-03-10' }),
      }, {})).body);
      const deleted = await handler({
        httpMethod: 'DELETE',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ expectedVersion: created.version }),
      }, {});
      assert.strictEqual(deleted.statusCode, 204);

      const staleWrite = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ comment: 'must not recreate', expectedVersion: created.version }),
      }, {});
      assert.strictEqual(staleWrite.statusCode, 404);
      assert.strictEqual(JSON.parse(staleWrite.body).code, 'task_not_found');
    });

    it('updates a task and returns 200', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Update me', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      await new Promise((r) => setTimeout(r, 10));

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'done', comment: 'Completed', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.status, 'done');
      assert.strictEqual(body.comment, 'Completed');
      assert.strictEqual(body.description, 'Update me');
      assert.strictEqual(body.version, 2);
      assert.ok(body.updatedAt > created.updatedAt);
    });

    it('records completedAt and completedBy when marking a task done', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Complete with actor', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        headers: { 'x-user-id': 'ops-manager' },
        body: JSON.stringify({ status: 'done', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.status, 'done');
      assert.strictEqual(body.completedBy, 'ops-manager');
      assert.ok(body.completedAt);
      assert.ok(Date.parse(body.completedAt));
    });

    it('rejects lifecycle updates of a skipped Task without writing', async () => {
      const client = await getClient(port);
      const archived = await createTask(client, {
        description: 'Retired Template Task',
        date: '2026-03-10',
        status: 'skipped',
        skipReason: 'Removed from the Card Template',
        skippedAt: '2026-03-09T12:00:00.000Z',
        skippedBy: 'template-operator',
        source: 'template',
        templateRetiredAt: '2026-03-09T12:00:00.000Z',
        templateRetiredReason: 'removed',
      });
      const mutations = [
        { status: 'todo' },
        {
          status: 'waiting',
          waitingFor: 'must not apply',
          followUpAt: '2026-03-12',
          comment: 'must not apply',
        },
        { status: 'done' },
        { waitingFor: 'must not apply' },
        { followUpAt: '2026-03-12', description: 'must not rename either' },
      ];
      for (const mutation of mutations) {
        const response = await handler({
          httpMethod: 'PUT',
          path: `/api/tasks/${archived.id}`,
          body: JSON.stringify({
            expectedVersion: archived.version,
            ...mutation,
          }),
        }, {});
        assert.strictEqual(response.statusCode, 400);
        assert.strictEqual(
          JSON.parse(response.body).error,
          'A skipped Task keeps its status and has no follow-up; unskip it first',
        );
        assert.deepStrictEqual(await getTask(client, archived.id), archived);
      }
    });

    it('edits a skipped Task like a done one and keeps it skipped', async () => {
      const client = await getClient(port);
      const skipped = await createTask(client, {
        description: 'Fill in the announcement **– Valeriia**',
        date: '2026-03-10',
        status: 'skipped',
        skipReason: 'Guest withdrew',
        skippedAt: '2026-03-09T12:00:00.000Z',
        skippedBy: 'ops-manager',
        tags: ['newsletter'],
      });
      const response = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${skipped.id}`,
        body: JSON.stringify({
          expectedVersion: skipped.version,
          description: 'Fill in the announcement',
          assigneeId: 'ops-manager',
          date: '2026-03-11',
          comment: 'Title cleaned',
        }),
      }, {});
      assert.strictEqual(response.statusCode, 200, response.body);
      const stored = await getTask(client, skipped.id);
      assert.ok(stored);
      assert.strictEqual(stored.status, 'skipped');
      assert.strictEqual(stored.skipReason, 'Guest withdrew');
      assert.strictEqual(stored.skippedAt, '2026-03-09T12:00:00.000Z');
      assert.strictEqual(stored.description, 'Fill in the announcement');
      assert.strictEqual(stored.assigneeId, 'ops-manager');
      assert.strictEqual(stored.date, '2026-03-11');
      assert.strictEqual(stored.version, skipped.version + 1);
    });

    it('returns 404 for a nonexistent task', async () => {
      const res = await handler({
        httpMethod: 'PUT',
        path: '/api/tasks/nonexistent-id-999',
        body: JSON.stringify({ status: 'done', expectedVersion: 1 }),
      }, {});

      assert.strictEqual(res.statusCode, 404);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Task not found');
    });

    it('returns 400 when body is empty', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'No update', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: null,
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Request body is required');
    });

    it('returns 400 when body is invalid JSON', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Bad update', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: 'not-json',
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Request body is required');
    });

    it('strips disallowed fields and only updates allowed ones', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Strip test', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'done', id: 'hacked', PK: 'bad', createdAt: '1999-01-01', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.id, created.id);
      assert.strictEqual(body.status, 'done');
      assert.ok(!body.PK);
    });

    it('returns 400 when only disallowed fields are provided', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'No valid', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ id: 'hacked', PK: 'bad', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'No valid fields to update');
    });

    it('updates a task to waiting with follow-up metadata', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Move to waiting', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({
          status: 'waiting',
          waitingFor: 'Venue response',
          followUpAt: '2026-03-15T10:30:00.000Z',
          comment: 'Waiting for venue response',
          expectedVersion: created.version,
        }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.status, 'waiting');
      assert.strictEqual(body.waitingFor, 'Venue response');
      assert.strictEqual(body.followUpAt, '2026-03-15T10:30:00.000Z');
      assert.strictEqual(body.comment, 'Waiting for venue response');

      const getRes = await handler({ httpMethod: 'GET', path: `/api/tasks/${created.id}` }, {});
      assert.strictEqual(getRes.statusCode, 200);
      const fetched = JSON.parse(getRes.body);
      assert.strictEqual(fetched.status, 'waiting');
      assert.strictEqual(fetched.waitingFor, 'Venue response');
      assert.strictEqual(fetched.followUpAt, '2026-03-15T10:30:00.000Z');
      assert.strictEqual(fetched.comment, 'Waiting for venue response');
    });

    it('returns 400 when updating a task to waiting without follow-up metadata', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Invalid waiting update', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'waiting', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Waiting tasks require waitingFor, followUpAt, and comment');
    });

    it('returns 400 when updating a task to waiting without a comment', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Invalid waiting note', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({
          status: 'waiting',
          waitingFor: 'Venue response',
          followUpAt: '2026-03-15T10:30:00.000Z',
          expectedVersion: created.version,
        }),
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Waiting tasks require waitingFor, followUpAt, and comment');
    });

    it('blocks a generic waiting task update back to todo without response history', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Resume task',
          date: '2026-03-10',
          status: 'waiting',
          waitingFor: 'Sponsor answer',
          followUpAt: '2026-03-16T08:00:00.000Z',
          comment: 'Waiting for sponsor answer',
        }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'todo', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(
        JSON.parse(res.body).error,
        'Waiting tasks must use the response received or unblocked action before returning to todo'
      );
    });

    it('blocks generic completion of a waiting task', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Finish waiting task',
          date: '2026-03-10',
          status: 'waiting',
          waitingFor: 'Contract signature',
          followUpAt: '2026-03-17T08:00:00.000Z',
          comment: 'Waiting for contract signature',
        }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(
        JSON.parse(res.body).error,
        'Waiting tasks must be resolved with the follow-up resolve action before completion'
      );
    });

    it('records the full follow-up action lifecycle with structured history', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Lifecycle follow-up task', date: '2026-06-28' }),
      }, {});
      assert.strictEqual(createRes.statusCode, 201);
      const created = JSON.parse(createRes.body);

      const waitingRes = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/mark-waiting`,
        headers: { 'x-user-id': 'ops-manager' },
        body: JSON.stringify({
          waitingFor: 'Sponsor assets',
          channel: 'email',
          followUpAt: '2026-07-01',
          note: 'Asked for logo and copy',
          expectedVersion: created.version,
        }),
      }, {});
      assert.strictEqual(waitingRes.statusCode, 200);
      const waiting = JSON.parse(waitingRes.body);
      assert.strictEqual(waiting.status, 'waiting');
      assert.strictEqual(waiting.waitingFor, 'Sponsor assets');
      assert.strictEqual(waiting.followUpAt, '2026-07-01');
      assert.strictEqual(waiting.followUpChannel, 'email');
      assert.strictEqual(waiting.taskHistory.length, 1);
      assert.strictEqual(waiting.taskHistory[0].action, 'waiting-started');
      assert.strictEqual(waiting.taskHistory[0].actorId, 'ops-manager');
      assert.strictEqual(waiting.taskHistory[0].note, 'Asked for logo and copy');

      const followUpRes = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/follow-up-sent`,
        headers: { 'x-user-id': 'ops-manager' },
        body: JSON.stringify({
          channel: 'email',
          note: 'Sent second reminder',
          nextFollowUpAt: '2026-07-02',
          expectedVersion: waiting.version,
        }),
      }, {});
      assert.strictEqual(followUpRes.statusCode, 200);
      const followedUp = JSON.parse(followUpRes.body);
      assert.strictEqual(followedUp.status, 'waiting');
      assert.strictEqual(followedUp.followUpAt, '2026-07-02');
      assert.strictEqual(followedUp.taskHistory.length, 2);
      assert.strictEqual(followedUp.taskHistory[1].action, 'follow-up-sent');
      assert.strictEqual(followedUp.taskHistory[1].previousFollowUpAt, '2026-07-01');

      const responseRes = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/response-received`,
        headers: { 'x-user-id': 'ops-manager' },
        body: JSON.stringify({
          note: 'Sponsor sent the assets',
          channel: 'email',
          expectedVersion: followedUp.version,
        }),
      }, {});
      assert.strictEqual(responseRes.statusCode, 200);
      const unblocked = JSON.parse(responseRes.body);
      assert.strictEqual(unblocked.status, 'todo');
      assert.strictEqual(unblocked.waitingFor, null);
      assert.strictEqual(unblocked.followUpAt, null);
      assert.strictEqual(unblocked.taskHistory.length, 3);
      assert.strictEqual(unblocked.taskHistory[2].action, 'response-received');
    });

    it('does not lose or duplicate concurrent lifecycle history', async () => {
      const created = JSON.parse((await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Concurrent follow-ups', date: '2026-06-28' }),
      }, {})).body);
      const waiting = JSON.parse((await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/mark-waiting`,
        body: JSON.stringify({
          waitingFor: 'Sponsor',
          channel: 'email',
          followUpAt: '2026-07-01',
          note: 'Initial request',
          expectedVersion: created.version,
        }),
      }, {})).body);

      const followUpRequest = (note: string) => handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/follow-up-sent`,
        body: JSON.stringify({
          channel: 'email',
          note,
          nextFollowUpAt: '2026-07-02',
          expectedVersion: waiting.version,
        }),
      }, {});
      const [left, right] = await Promise.all([
        followUpRequest('Concurrent left'),
        followUpRequest('Concurrent right'),
      ]);
      const winner = [left, right].find((response) => response.statusCode === 200);
      const loser = [left, right].find((response) => response.statusCode === 409);
      assert.ok(winner);
      assert.ok(loser);
      const afterRace = JSON.parse(winner.body);
      assert.strictEqual(afterRace.version, 3);
      assert.strictEqual(afterRace.taskHistory.length, 2);
      const acceptedNote = afterRace.taskHistory.at(-1).note;
      const losingNote = acceptedNote === 'Concurrent left' ? 'Concurrent right' : 'Concurrent left';

      const retried = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/follow-up-sent`,
        body: JSON.stringify({
          channel: 'email',
          note: losingNote,
          nextFollowUpAt: '2026-07-03',
          expectedVersion: JSON.parse(loser.body).currentVersion,
        }),
      }, {});
      assert.strictEqual(retried.statusCode, 200, retried.body);
      const afterRetry = JSON.parse(retried.body);
      assert.strictEqual(afterRetry.version, 4);
      assert.deepStrictEqual(
        afterRetry.taskHistory.map((event: any) => event.note),
        ['Initial request', acceptedNote, losingNote],
      );
    });

    it('requires channel, note, and follow-up date for follow-up actions', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Validation follow-up task', date: '2026-06-28' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const missingWaiting = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/mark-waiting`,
        body: JSON.stringify({ waitingFor: 'Sponsor', followUpAt: '2026-07-01', note: 'Missing channel', expectedVersion: created.version }),
      }, {});
      assert.strictEqual(missingWaiting.statusCode, 400);
      assert.strictEqual(JSON.parse(missingWaiting.body).error, 'channel is required');

      const waitingRes = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/mark-waiting`,
        body: JSON.stringify({
          waitingFor: 'Sponsor',
          channel: 'email',
          followUpAt: '2026-07-01',
          note: 'Waiting for assets',
          expectedVersion: created.version,
        }),
      }, {});

      const missingFollowUpNote = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/follow-up-sent`,
        body: JSON.stringify({ channel: 'email', nextFollowUpAt: '2026-07-02', expectedVersion: JSON.parse(waitingRes.body).version }),
      }, {});
      assert.strictEqual(missingFollowUpNote.statusCode, 400);
      assert.strictEqual(JSON.parse(missingFollowUpNote.body).error, 'note is required');

      const missingFollowUpDate = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/follow-up-sent`,
        body: JSON.stringify({ channel: 'email', note: 'Sent reminder', expectedVersion: JSON.parse(waitingRes.body).version }),
      }, {});
      assert.strictEqual(missingFollowUpDate.statusCode, 400);
      assert.strictEqual(JSON.parse(missingFollowUpDate.body).error, 'nextFollowUpAt is required');
    });

    it('resolves a waiting task as done only through the explicit action and existing proof gates', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Resolve with proof',
          date: '2026-06-28',
          requiredLinkName: 'Luma',
        }),
      }, {});
      const created = JSON.parse(createRes.body);

      const waitingRes = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/mark-waiting`,
        body: JSON.stringify({
          waitingFor: 'Speaker confirmation',
          channel: 'email',
          followUpAt: '2026-07-01',
          note: 'Waiting for approval',
          expectedVersion: created.version,
        }),
      }, {});

      const blocked = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/resolve-done`,
        body: JSON.stringify({ note: 'Speaker replied', expectedVersion: JSON.parse(waitingRes.body).version }),
      }, {});
      assert.strictEqual(blocked.statusCode, 400);
      assert.strictEqual(JSON.parse(blocked.body).error, "Cannot mark task as done: required link 'Luma' is not filled");

      const resolved = await handler({
        httpMethod: 'POST',
        path: `/api/tasks/${created.id}/actions/resolve-done`,
        headers: { 'x-user-id': 'ops-manager' },
        body: JSON.stringify({
          note: 'Speaker replied and page is ready',
          link: 'https://luma.com/event',
          expectedVersion: JSON.parse(waitingRes.body).version,
        }),
      }, {});
      assert.strictEqual(resolved.statusCode, 200);
      const body = JSON.parse(resolved.body);
      assert.strictEqual(body.status, 'done');
      assert.strictEqual(body.waitingFor, null);
      assert.strictEqual(body.followUpAt, null);
      assert.strictEqual(body.completedBy, 'ops-manager');
      assert.strictEqual(body.version, 3);
      assert.strictEqual(body.taskHistory[body.taskHistory.length - 2].action, 'wait-resolved');
      assert.strictEqual(body.taskHistory[body.taskHistory.length - 1].action, 'completed');
    });
  });

  // ── DELETE /api/tasks/:id ──────────────────────────────────────────

  describe('DELETE /api/tasks/:id', () => {
    it('rejects a missing or alternate delete precondition', async () => {
      const created = JSON.parse((await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Delete precondition', date: '2026-03-10' }),
      }, {})).body);
      for (const body of [{}, { version: created.version }]) {
        const response = await handler({
          httpMethod: 'DELETE',
          path: `/api/tasks/${created.id}`,
          body: JSON.stringify(body),
        }, {});
        assert.strictEqual(response.statusCode, 400);
      }
      assert.ok(await handler({ httpMethod: 'GET', path: `/api/tasks/${created.id}` }, {}));
    });

    it('deletes a task and returns 204', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Delete me', date: '2026-03-10' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'DELETE',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 204);
      assert.strictEqual(res.body, '');

      const getRes = await handler({
        httpMethod: 'GET',
        path: `/api/tasks/${created.id}`,
      }, {});
      assert.strictEqual(getRes.statusCode, 404);
    });

    it('returns 404 for a nonexistent task', async () => {
      const res = await handler({
        httpMethod: 'DELETE',
        path: '/api/tasks/nonexistent-id-999',
        body: JSON.stringify({ expectedVersion: 1 }),
      }, {});

      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(JSON.parse(res.body).code, 'task_not_found');
    });
  });

  // ── Existing routes still work ─────────────────────────────────────

  describe('Existing routes', () => {
    it('GET / returns SPA HTML with status 200', async () => {
      const res = await handler({ httpMethod: 'GET', path: '/' }, {});
      assert.strictEqual(res.statusCode, 200);
      assert.match(res.headers!['Content-Type'], /^text\/html/);
      assert.ok(res.body.includes('<title>DataOps</title>'));
    });

    it('GET /api/health returns 200', async () => {
      const res = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body, { status: 'ok' });
    });

    it('GET /api/unknown returns 404', async () => {
      const res = await handler({ httpMethod: 'GET', path: '/api/unknown' }, {});
      assert.strictEqual(res.statusCode, 404);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe('Error handling — 500 on unexpected errors', () => {
    it('returns 500 when an unexpected error occurs', async () => {
      const { route } = await import('../src/router');

      const brokenClient = {
        send: () => { throw new Error('Simulated DB failure'); },
      };

      const res = await route(
        {
          httpMethod: 'GET',
          path: '/api/tasks',
          queryStringParameters: { date: '2026-01-01' },
        },
        brokenClient as any,
      );

      assert.strictEqual(res.statusCode, 500);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Internal server error');
    });
  });

  // ── Ad hoc task polish ──────────────────────────────────────────────

  describe('Source defaults to manual', () => {
    it('creating a task without source defaults to "manual"', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Ad hoc task', date: '2096-01-01' }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 201);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.source, 'manual');
    });

    it('creating a task with an explicit source preserves it', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Bot task', date: '2096-01-02', source: 'telegram' }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 201);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.source, 'telegram');
    });
  });

  describe('Creating a task with a comment', () => {
    it('creates a task with a comment field', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Task with comment',
          date: '2096-02-01',
          comment: 'This is a note',
        }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 201);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.comment, 'This is a note');
      assert.strictEqual(body.source, 'manual');
    });

    it('creates a task without a comment field', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Task without comment',
          date: '2096-02-02',
        }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 201);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.comment, undefined);
    });
  });

  // ── New fields (instructionsUrl, doc context, link, requiredLinkName, assigneeId, tags) ──

  describe('POST /api/tasks with new fields', () => {
    it('creates a task with all new fields', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Create Luma event',
          date: '2026-04-01',
          instructionsUrl: 'https://docs.google.com/luma-howto',
          instructionDocId: 'sop.media.podcast.create-podcast-document',
          instructionStepId: '4',
          phase: 'preparation',
          requires: ['luma', 'airtable'],
          validation: { requiredEvidence: 'Luma link' },
          link: 'https://luma.com/event-123',
          requiredLinkName: 'Luma',
          assigneeId: 'user-grace',
          tags: ['webinar', 'community'],
        }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 201);

      const body = JSON.parse(res.body);
      assert.ok(body.id);
      assert.strictEqual(body.description, 'Create Luma event');
      assert.strictEqual(body.date, '2026-04-01');
      assert.strictEqual(body.status, 'todo');
      assert.strictEqual(body.source, 'manual');
      assert.strictEqual(body.instructionsUrl, 'https://docs.google.com/luma-howto');
      assert.strictEqual(body.instructionDocId, 'sop.media.podcast.create-podcast-document');
      assert.strictEqual(body.instructionStepId, '4');
      assert.strictEqual(body.phase, 'preparation');
      assert.deepStrictEqual(body.requires, ['luma', 'airtable']);
      assert.deepStrictEqual(body.validation, { requiredEvidence: 'Luma link' });
      assert.strictEqual(body.link, 'https://luma.com/event-123');
      assert.strictEqual(body.requiredLinkName, 'Luma');
      assert.strictEqual(body.assigneeId, 'user-grace');
      assert.deepStrictEqual(body.tags, ['webinar', 'community']);
    });

    it('creates a canonical Task from only required input fields', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Simple task', date: '2026-04-01' }),
      };
      const res = await handler(event, {});
      assert.strictEqual(res.statusCode, 201);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.instructionsUrl, undefined);
      assert.strictEqual(body.instructionDocId, undefined);
      assert.strictEqual(body.link, undefined);
      assert.strictEqual(body.requiredLinkName, undefined);
      assert.strictEqual(body.assigneeId, undefined);
      assert.strictEqual(body.tags, undefined);
    });
  });

  describe('leading [Tag] extraction into tags', () => {
    it('splits a bracket prefix off the description on create', async () => {
      const res = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: '[Podcast page] Add a podcast episode', date: '2026-04-01' }),
      }, {});
      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.description, 'Add a podcast episode');
      assert.deepStrictEqual(body.tags, ['Podcast page']);
    });

    it('keeps explicit tags and leaves the description untouched', async () => {
      const res = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: '[Podcast page] Add a podcast episode',
          date: '2026-04-01',
          tags: ['custom'],
        }),
      }, {});
      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.description, '[Podcast page] Add a podcast episode');
      assert.deepStrictEqual(body.tags, ['custom']);
    });

    it('rejects malformed tags', async () => {
      const res = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Tagged', date: '2026-04-01', tags: ['ok', 42] }),
      }, {});
      assert.strictEqual(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /tags/);
    });

    it('splits a bracket prefix off the description on update', async () => {
      const created = JSON.parse((await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Base task', date: '2026-04-01' }),
      }, {})).body);
      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ description: '[Other tasks] Renamed task', expectedVersion: created.version }),
      }, {});
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.description, 'Renamed task');
      assert.deepStrictEqual(body.tags, ['Other tasks']);
    });
  });

  describe('links pasted into a title move into materials', () => {
    const doc = 'https://docs.google.com/document/d/abc/edit';

    it('cleans the title on create and stores the link as a material', async () => {
      const res = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: `[Announce] Announce in Slack ( , [template](${doc}?usp=sharing]))`,
          date: '2026-04-01',
        }),
      }, {});
      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.description, 'Announce in Slack');
      assert.deepStrictEqual(body.tags, ['Announce']);
      assert.deepStrictEqual(body.materials, [{ url: doc, label: 'template' }]);
    });

    it('stores supplied materials clean and adds title links after them', async () => {
      const res = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Record the intro - video https://www.loom.com/share/xyz',
          date: '2026-04-01',
          materials: [{ url: `${doc}?usp=sharing`, label: ' Brief ' }],
        }),
      }, {});
      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.description, 'Record the intro - video');
      assert.deepStrictEqual(body.materials, [
        { url: doc, label: 'Brief' },
        { url: 'https://www.loom.com/share/xyz' },
      ]);
    });

    it('merges title links into existing materials on update', async () => {
      const created = JSON.parse((await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Base task', date: '2026-04-01', materials: [{ url: doc }] }),
      }, {})).body);
      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({
          description: 'Post the recap ([doc](https://docs.google.com/document/d/abc/edit)) - [site](https://github.com/o/r)',
          expectedVersion: created.version,
        }),
      }, {});
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.description, 'Post the recap');
      assert.deepStrictEqual(body.materials, [{ url: doc }, { url: 'https://github.com/o/r', label: 'site' }]);
    });

    it('keeps a title that is nothing but a link', async () => {
      const res = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: `[brief](${doc})`, date: '2026-04-01' }),
      }, {});
      assert.strictEqual(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.description, `[brief](${doc})`);
      assert.strictEqual(body.materials, undefined);
    });

    it('rejects malformed materials', async () => {
      for (const materials of [{ url: doc }, [{ url: 'ftp://x' }], [{ url: doc, label: 3 }], ['x']]) {
        const res = await handler({
          httpMethod: 'POST',
          path: '/api/tasks',
          body: JSON.stringify({ description: 'Bad materials', date: '2026-04-01', materials }),
        }, {});
        assert.strictEqual(res.statusCode, 400, JSON.stringify(materials));
        assert.match(JSON.parse(res.body).error, /materials/);
      }
    });
  });

  describe('PUT /api/tasks/:id with new fields', () => {
    it('updates a task to add new fields', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Base task', date: '2026-04-01' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({
          instructionsUrl: 'https://docs.google.com/guide',
          instructionDocId: 'sop.media.podcast.create-podcast-document',
          instructionStepId: '2',
          phase: 'preparation',
          requires: ['google-drive'],
          validation: 'Check the shared doc',
          assigneeId: 'user-valeriia',
          tags: ['newsletter'],
          expectedVersion: created.version,
        }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.instructionsUrl, 'https://docs.google.com/guide');
      assert.strictEqual(body.instructionDocId, 'sop.media.podcast.create-podcast-document');
      assert.strictEqual(body.instructionStepId, '2');
      assert.strictEqual(body.phase, 'preparation');
      assert.deepStrictEqual(body.requires, ['google-drive']);
      assert.strictEqual(body.validation, 'Check the shared doc');
      assert.strictEqual(body.assigneeId, 'user-valeriia');
      assert.deepStrictEqual(body.tags, ['newsletter']);
      assert.strictEqual(body.description, 'Base task');
    });

    it('rejects malformed doc-context fields', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Base task', date: '2026-04-01' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const badRequires = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ requires: ['github', 42], expectedVersion: created.version }),
      }, {});
      assert.strictEqual(badRequires.statusCode, 400);
      assert.match(JSON.parse(badRequires.body).error, /requires/);

      const badValidation = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ validation: ['nope'], expectedVersion: created.version }),
      }, {});
      assert.strictEqual(badValidation.statusCode, 400);
      assert.match(JSON.parse(badValidation.body).error, /validation/);
    });
  });

  describe('requiredLinkName validation', () => {
    it('returns 400 when marking done with requiredLinkName set but link empty', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Link required task',
          date: '2026-04-01',
          requiredLinkName: 'Luma',
        }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, "Cannot mark task as done: required link 'Luma' is not filled");
    });

    it('allows done when providing link in the same request', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Link required task 2',
          date: '2026-04-01',
          requiredLinkName: 'Luma',
        }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'done', link: 'https://luma.com/event', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.status, 'done');
      assert.strictEqual(body.link, 'https://luma.com/event');
    });

    it('allows done when link was previously filled', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Link required task 3',
          date: '2026-04-01',
          requiredLinkName: 'Luma',
          link: 'https://luma.com/event',
        }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.status, 'done');
    });

    it('allows done when requiredLinkName is not set', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'No link requirement',
          date: '2026-04-01',
        }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.status, 'done');
    });

    it('writes task link to Card cardLinks when completing a task and also accepts a pre-filled Card link', async () => {
      const cardRes = await handler({
        httpMethod: 'POST',
        path: '/api/cards',
        body: JSON.stringify({
          title: 'Podcast episode link sync',
          anchorDate: '2026-07-20',
          templateId: EMPTY_TEMPLATE_ID,
          cardLinks: [
            { name: 'Podcast document', url: '' },
            { name: 'Luma', url: 'https://lu.ma/pre-filled' },
          ],
        }),
      }, {});
      assert.strictEqual(cardRes.statusCode, 201, cardRes.body);
      const card = JSON.parse(cardRes.body).card;

      const docTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Create the podcast document',
          date: '2026-07-10',
          cardId: card.id,
          requiredLinkName: 'Podcast document',
          proofRequirement: { type: 'url', label: 'Podcast document', required: true },
          validation: { requiredCardLinks: ['Podcast document'] },
        }),
      }, {});
      assert.strictEqual(docTaskRes.statusCode, 201, docTaskRes.body);
      const docTask = JSON.parse(docTaskRes.body);

      const doneDocRes = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${docTask.id}`,
        body: JSON.stringify({
          status: 'done',
          link: 'https://docs.example/podcast-doc',
          expectedVersion: docTask.version,
        }),
      }, {});
      assert.strictEqual(doneDocRes.statusCode, 200, doneDocRes.body);
      assert.strictEqual(JSON.parse(doneDocRes.body).link, 'https://docs.example/podcast-doc');

      const updatedCardRes = await handler({ httpMethod: 'GET', path: `/api/cards/${card.id}` }, {});
      const updatedCard = JSON.parse(updatedCardRes.body).card;
      assert.deepStrictEqual(
        updatedCard.cardLinks.find((entry: { name: string }) => entry.name === 'Podcast document'),
        { name: 'Podcast document', url: 'https://docs.example/podcast-doc' },
      );

      const lumaTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Create Luma event',
          date: '2026-07-11',
          cardId: card.id,
          requiredLinkName: 'Luma',
          proofRequirement: { type: 'url', label: 'Luma', required: true },
          validation: { requiredCardLinks: ['Luma'] },
        }),
      }, {});
      assert.strictEqual(lumaTaskRes.statusCode, 201, lumaTaskRes.body);
      const lumaTask = JSON.parse(lumaTaskRes.body);

      const doneLumaRes = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${lumaTask.id}`,
        body: JSON.stringify({
          status: 'done',
          expectedVersion: lumaTask.version,
        }),
      }, {});
      assert.strictEqual(doneLumaRes.statusCode, 200, doneLumaRes.body);
      assert.strictEqual(JSON.parse(doneLumaRes.body).link, 'https://lu.ma/pre-filled');
    });
  });

  describe('proofRequirement validation', () => {
    it('rejects done without required comment proof and does not record completion fields', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Comment proof task',
          date: '2026-04-01',
          proofRequirement: { type: 'comment', label: 'Completion note' },
        }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: created.version }),
      }, {});

      assert.strictEqual(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, "Cannot mark task as done: required comment proof 'Completion note' is missing");

      const fetchedRes = await handler({ httpMethod: 'GET', path: `/api/tasks/${created.id}` }, {});
      const fetched = JSON.parse(fetchedRes.body);
      assert.strictEqual(fetched.status, 'todo');
      assert.strictEqual(fetched.completedAt, undefined);
      assert.strictEqual(fetched.completedBy, undefined);
    });

    it('requires approved artifact records for artifact proof and still accepts external-status proof', async () => {
      const artifactTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Artifact proof task',
          date: '2026-04-01',
          proofRequirement: { type: 'artifact', label: 'Generated draft' },
        }),
      }, {});
      const artifactTask = JSON.parse(artifactTaskRes.body);

      const refOnlyDone = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${artifactTask.id}`,
        body: JSON.stringify({
          status: 'done',
          artifactRefs: [{ artifactId: 'artifact-1', type: 'draft', storageUri: 's3://bucket/draft.md' }],
          expectedVersion: artifactTask.version,
        }),
      }, {});
      assert.strictEqual(refOnlyDone.statusCode, 400);
      assert.match(JSON.parse(refOnlyDone.body).error, /approved artifact proof 'Generated draft' is missing/);

      await handler({
        httpMethod: 'POST',
        path: '/api/artifacts',
        body: JSON.stringify({
          type: 'external-link',
          title: 'Generated draft',
          storageUri: 'https://example.com/generated-draft',
          storageProvider: 'external-url',
          dataClass: 'internal',
          sourceType: 'manual-link',
          status: 'approved',
          reviewedBy: 'reviewer',
          taskId: artifactTask.id,
        }),
      }, {});

      const refreshedArtifactTask = JSON.parse((await handler({
        httpMethod: 'GET',
        path: `/api/tasks/${artifactTask.id}`,
      }, {})).body);
      const artifactDone = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${artifactTask.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: refreshedArtifactTask.version }),
      }, {});
      assert.strictEqual(artifactDone.statusCode, 200);
      const artifactDoneBody = JSON.parse(artifactDone.body);
      assert.strictEqual(artifactDoneBody.status, 'done');

      const statusTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'External status proof task',
          date: '2026-04-01',
          proofRequirement: { type: 'external-status', label: 'External approval' },
        }),
      }, {});
      const statusTask = JSON.parse(statusTaskRes.body);

      const statusDone = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${statusTask.id}`,
        body: JSON.stringify({ status: 'done', externalStatus: 'approved', expectedVersion: statusTask.version }),
      }, {});
      assert.strictEqual(statusDone.statusCode, 200);
      const statusDoneBody = JSON.parse(statusDone.body);
      assert.strictEqual(statusDoneBody.status, 'done');
      assert.strictEqual(statusDoneBody.externalStatus, 'approved');
    });

    it('allows an explicit skip closure to complete URL/file proof tasks without weakening normal proof gates', async () => {
      const validation = {
        skipClosure: {
          allowedStatuses: ['not sponsored this week'],
          requires: ['comment'],
        },
      };

      const sponsorDocTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Create sponsorship document',
          date: '2026-04-01',
          requiredLinkName: 'Sponsorship document',
          proofRequirement: { type: 'url', label: 'Sponsorship document', required: true },
          validation,
        }),
      }, {});
      const sponsorDocTask = JSON.parse(sponsorDocTaskRes.body);

      const sponsorDocWrongSkip = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${sponsorDocTask.id}`,
        body: JSON.stringify({ status: 'done', comment: 'no sponsor', expectedVersion: sponsorDocTask.version }),
      }, {});
      assert.strictEqual(sponsorDocWrongSkip.statusCode, 400);
      assert.strictEqual(JSON.parse(sponsorDocWrongSkip.body).error, "Cannot mark task as done: required link 'Sponsorship document' is not filled");

      const skippedSponsorDoc = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${sponsorDocTask.id}`,
        body: JSON.stringify({ status: 'done', comment: 'not sponsored this week', expectedVersion: sponsorDocTask.version }),
      }, {});
      assert.strictEqual(skippedSponsorDoc.statusCode, 200);
      const skippedSponsorDocBody = JSON.parse(skippedSponsorDoc.body);
      assert.strictEqual(skippedSponsorDocBody.status, 'done');
      assert.strictEqual(skippedSponsorDocBody.link, undefined);
      assert.strictEqual(skippedSponsorDocBody.comment, 'not sponsored this week');

      const linkTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Newsletter sponsored LinkedIn post',
          date: '2026-04-01',
          requiredLinkName: 'LinkedIn',
          proofRequirement: { type: 'url', label: 'LinkedIn', required: true },
          validation,
        }),
      }, {});
      const linkTask = JSON.parse(linkTaskRes.body);

      const missingSkip = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${linkTask.id}`,
        body: JSON.stringify({ status: 'done', comment: 'no sponsor', expectedVersion: linkTask.version }),
      }, {});
      assert.strictEqual(missingSkip.statusCode, 400);
      assert.strictEqual(JSON.parse(missingSkip.body).error, "Cannot mark task as done: required link 'LinkedIn' is not filled");

      const skippedLink = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${linkTask.id}`,
        body: JSON.stringify({ status: 'done', comment: '[2026-04-01T09:00:00.000Z] not sponsored this week', expectedVersion: linkTask.version }),
      }, {});
      assert.strictEqual(skippedLink.statusCode, 200);
      const skippedLinkBody = JSON.parse(skippedLink.body);
      assert.strictEqual(skippedLinkBody.status, 'done');
      assert.strictEqual(skippedLinkBody.link, undefined);
      assert.match(skippedLinkBody.comment, /not sponsored this week/);

      const fileTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Newsletter sponsor invoice',
          date: '2026-04-01',
          requiresFile: true,
          proofRequirement: { type: 'file', label: 'Invoice PDF or invoice proof', required: true },
          validation,
        }),
      }, {});
      const fileTask = JSON.parse(fileTaskRes.body);

      const skippedFile = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${fileTask.id}`,
        body: JSON.stringify({ status: 'done', comment: 'not sponsored this week', expectedVersion: fileTask.version }),
      }, {});
      assert.strictEqual(skippedFile.statusCode, 200);
      const skippedFileBody = JSON.parse(skippedFile.body);
      assert.strictEqual(skippedFileBody.status, 'done');
      assert.strictEqual(skippedFileBody.requiresFile, true);
      assert.strictEqual(skippedFileBody.comment, 'not sponsored this week');

      const normalFileTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Normal invoice',
          date: '2026-04-01',
          requiresFile: true,
          proofRequirement: { type: 'file', label: 'Invoice PDF', required: true },
        }),
      }, {});
      const normalFileTask = JSON.parse(normalFileTaskRes.body);

      const normalFileDone = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${normalFileTask.id}`,
        body: JSON.stringify({ status: 'done', comment: 'not sponsored this week', expectedVersion: normalFileTask.version }),
      }, {});
      assert.strictEqual(normalFileDone.statusCode, 400);
      assert.strictEqual(JSON.parse(normalFileDone.body).error, 'Cannot mark task as done: required file has not been uploaded');
    });

    it('blocks schedule-email-newsletter from announcing until the Mailchimp shared card link is filled', async () => {
      const template = await createTemplate(await getClient(port), {
          name: 'Newsletter shared-link gate',
          type: 'newsletter',
          cardLinkDefinitions: [{ name: 'Mailchimp newsletter' }],
          taskDefinitions: [{
            refId: 'schedule-email-newsletter',
            description: 'Schedule Email Newsletter',
            offsetDays: 0,
            stageOnComplete: 'announced',
            proofRequirement: { type: 'external-status', label: 'Mailchimp campaign scheduled', required: true },
            validation: { requiredCardLinks: ['Mailchimp newsletter'] },
          }],
      });

      const cardRes = await handler({
        httpMethod: 'POST',
        path: '/api/cards',
        body: JSON.stringify({
          title: 'Newsletter required card links',
          anchorDate: '2026-07-20',
          templateId: template.id,
          stage: 'preparation',
          cardLinks: [{ name: 'Mailchimp newsletter', url: '' }],
        }),
      }, {});
      assert.strictEqual(cardRes.statusCode, 201, cardRes.body);
      const cardBody = JSON.parse(cardRes.body);
      const card = cardBody.card;
      const task = cardBody.tasks[0];
      assert.strictEqual(task.stageOnComplete, 'announced');

      const blockedDone = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${task.id}`,
        body: JSON.stringify({ status: 'done', externalStatus: 'Mailchimp campaign scheduled', expectedVersion: task.version }),
      }, {});
      assert.strictEqual(blockedDone.statusCode, 400);
      assert.strictEqual(JSON.parse(blockedDone.body).error, "Cannot mark task as done: required card link 'Mailchimp newsletter' is not filled");

      const blockedCardRes = await handler({ httpMethod: 'GET', path: `/api/cards/${card.id}` }, {});
      assert.strictEqual(JSON.parse(blockedCardRes.body).card.stage, 'preparation');

      const cardUpdateRes = await handler({
        httpMethod: 'PUT',
        path: `/api/cards/${card.id}`,
        body: JSON.stringify({
          expectedVersion: card.version,
          cardLinks: [{ name: 'Mailchimp newsletter', url: 'https://mailchimp.example/newsletter' }],
        }),
      }, {});
      assert.strictEqual(cardUpdateRes.statusCode, 200);

      const doneRes = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${task.id}`,
        body: JSON.stringify({ status: 'done', externalStatus: 'Mailchimp campaign scheduled', expectedVersion: task.version }),
      }, {});
      assert.strictEqual(doneRes.statusCode, 200);
      assert.strictEqual(JSON.parse(doneRes.body).status, 'done');

      const announcedCardRes = await handler({ httpMethod: 'GET', path: `/api/cards/${card.id}` }, {});
      assert.strictEqual(JSON.parse(announcedCardRes.body).card.stage, 'done');
      assert.strictEqual(JSON.parse(announcedCardRes.body).card.status, 'archived');
    });

    it('allows non-done tasks with required shared links without a card but blocks done', async () => {
      const validation = { requiredCardLinks: ['Mailchimp newsletter'] };
      const todoRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Ad hoc shared-link task',
          date: '2026-07-20',
          validation,
          proofRequirement: { type: 'external-status', label: 'Mailchimp campaign scheduled', required: true },
        }),
      }, {});
      assert.strictEqual(todoRes.statusCode, 201, todoRes.body);
      const task = JSON.parse(todoRes.body);
      assert.strictEqual(task.status, 'todo');

      const updateDone = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${task.id}`,
        body: JSON.stringify({ status: 'done', externalStatus: 'Mailchimp campaign scheduled', expectedVersion: task.version }),
      }, {});
      assert.strictEqual(updateDone.statusCode, 400);
      assert.strictEqual(JSON.parse(updateDone.body).error, "Cannot mark task as done: required shared card link 'Mailchimp newsletter' needs a workflow card");

      const createDone = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Ad hoc done shared-link task',
          date: '2026-07-20',
          status: 'done',
          validation,
          externalStatus: 'Mailchimp campaign scheduled',
          proofRequirement: { type: 'external-status', label: 'Mailchimp campaign scheduled', required: true },
        }),
      }, {});
      assert.strictEqual(createDone.statusCode, 400);
      assert.strictEqual(JSON.parse(createDone.body).error, "Cannot mark task as done: required shared card link 'Mailchimp newsletter' needs a workflow card");
    });

    it('blocks missing performance shared links unless an audited sponsor-only skip closure is present', async () => {
      const cardRes = await handler({
        httpMethod: 'POST',
        path: '/api/cards',
        body: JSON.stringify({
          title: 'Newsletter sponsor-only shared links',
          anchorDate: '2026-07-20',
          templateId: EMPTY_TEMPLATE_ID,
          cardLinks: [
            { name: 'Mailchimp newsletter', url: 'https://mailchimp.example/newsletter' },
            { name: 'LinkedIn', url: '' },
            { name: 'X', url: '' },
          ],
        }),
      }, {});
      assert.strictEqual(cardRes.statusCode, 201);
      const card = JSON.parse(cardRes.body).card;

      const validation = {
        requiredCardLinks: ['Mailchimp newsletter', 'LinkedIn', 'X'],
        skipClosure: {
          allowedStatuses: ['not sponsored this week', 'no social stats available'],
          requires: ['comment'],
          suppresses: {
            'not sponsored this week': { cardLinks: ['LinkedIn', 'X'], proof: true },
            'no social stats available': { cardLinks: ['LinkedIn', 'X'], proof: true },
          },
        },
      };

      const statsTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Add newsletter performance',
          date: '2026-07-27',
          cardId: card.id,
          source: 'template',
          proofRequirement: { type: 'external-status', label: 'Newsletter, LinkedIn, and X performance stats recorded', required: true },
          validation,
        }),
      }, {});
      assert.strictEqual(statsTaskRes.statusCode, 201);
      const statsTask = JSON.parse(statsTaskRes.body);

      const blockedStats = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${statsTask.id}`,
        body: JSON.stringify({
          status: 'done',
          externalStatus: 'Performance stats recorded',
          expectedVersion: statsTask.version,
        }),
      }, {});
      assert.strictEqual(blockedStats.statusCode, 400);
      assert.strictEqual(JSON.parse(blockedStats.body).error, "Cannot mark task as done: required card link 'LinkedIn' is not filled");

      const skippedStats = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${statsTask.id}`,
        body: JSON.stringify({
          status: 'done',
          comment: 'not sponsored this week',
          expectedVersion: statsTask.version,
        }),
      }, {});
      assert.strictEqual(skippedStats.statusCode, 200);
      assert.strictEqual(JSON.parse(skippedStats.body).status, 'done');
      assert.strictEqual(JSON.parse(skippedStats.body).comment, 'not sponsored this week');

      const missingMailchimpCardRes = await handler({
        httpMethod: 'POST',
        path: '/api/cards',
        body: JSON.stringify({
          title: 'Newsletter social-only skip still needs Mailchimp',
          anchorDate: '2026-07-20',
          templateId: EMPTY_TEMPLATE_ID,
          cardLinks: [
            { name: 'Mailchimp newsletter', url: '' },
            { name: 'LinkedIn', url: '' },
            { name: 'X', url: '' },
          ],
        }),
      }, {});
      assert.strictEqual(missingMailchimpCardRes.statusCode, 201);
      const missingMailchimpCard = JSON.parse(missingMailchimpCardRes.body).card;
      const missingMailchimpTaskRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Add newsletter performance missing Mailchimp',
          date: '2026-07-27',
          cardId: missingMailchimpCard.id,
          source: 'template',
          proofRequirement: { type: 'external-status', label: 'Newsletter, LinkedIn, and X performance stats recorded', required: true },
          validation,
        }),
      }, {});
      assert.strictEqual(missingMailchimpTaskRes.statusCode, 201);
      const missingMailchimpTask = JSON.parse(missingMailchimpTaskRes.body);

      const socialOnlySkip = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${missingMailchimpTask.id}`,
        body: JSON.stringify({
          status: 'done',
          comment: 'no social stats available',
          expectedVersion: missingMailchimpTask.version,
        }),
      }, {});
      assert.strictEqual(socialOnlySkip.statusCode, 400);
      assert.strictEqual(JSON.parse(socialOnlySkip.body).error, "Cannot mark task as done: required card link 'Mailchimp newsletter' is not filled");
    });

    it('rejects malformed proof requirements and metadata refs', async () => {
      const badProof = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Bad proof task',
          date: '2026-04-01',
          proofRequirement: { type: 'unsupported' },
        }),
      }, {});
      assert.strictEqual(badProof.statusCode, 400);
      assert.match(JSON.parse(badProof.body).error, /proofRequirement\.type/);

      const badRefs = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Bad refs task',
          date: '2026-04-01',
          artifactRefs: [{ type: 'draft' }],
        }),
      }, {});
      assert.strictEqual(badRefs.statusCode, 400);
      assert.match(JSON.parse(badRefs.body).error, /artifactRefs/);
    });
  });

  describe('POST /api/tasks/:id/actions/skip and unskip', () => {
    async function skipAction(taskId: string, body: Record<string, unknown>, action = 'skip') {
      return handler({
        httpMethod: 'POST',
        path: `/api/tasks/${taskId}/actions/${action}`,
        headers: { 'x-user-id': 'skip-operator' },
        body: JSON.stringify(body),
      }, {});
    }

    it('skips a gated Task with a reason, bypassing link, file, and proof gates', async () => {
      const client = await getClient(port);
      const card = await createCard(client, { ...templateLink(), title: 'Skip gate Card', anchorDate: '2026-05-01' });
      const gated = await createTask(client, {
        description: 'Gated step',
        date: '2026-05-01',
        cardId: card.id,
        requiredLinkName: 'Recording',
        requiresFile: true,
        proofRequirement: { type: 'url', label: 'Recording URL' },
      });
      const done = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${gated.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: gated.version }),
      }, {});
      assert.strictEqual(done.statusCode, 400, 'completion stays gated');

      const res = await skipAction(gated.id, {
        expectedVersion: gated.version,
        reason: '  Self-hosted event, no recording  ',
      });
      assert.strictEqual(res.statusCode, 200, res.body);
      const skipped = JSON.parse(res.body);
      assert.strictEqual(skipped.status, 'skipped');
      assert.strictEqual(skipped.skipReason, 'Self-hosted event, no recording');
      assert.strictEqual(skipped.skippedBy, 'skip-operator');
      assert.ok(Date.parse(skipped.skippedAt));
      assert.strictEqual(skipped.version, gated.version + 1);
      assert.strictEqual(skipped.completedAt, undefined);
      assert.deepStrictEqual(
        {
          action: skipped.taskHistory.at(-1).action,
          actorId: skipped.taskHistory.at(-1).actorId,
          note: skipped.taskHistory.at(-1).note,
          cardId: skipped.taskHistory.at(-1).cardId,
          createdAt: skipped.taskHistory.at(-1).createdAt,
        },
        {
          action: 'skipped',
          actorId: 'skip-operator',
          note: 'Self-hosted event, no recording',
          cardId: card.id,
          createdAt: skipped.skippedAt,
        },
      );
    });

    it('requires a reason and the current version, writing nothing otherwise', async () => {
      const client = await getClient(port);
      const task = await createTask(client, { description: 'Needs reason', date: '2026-05-02' });
      for (const body of [
        { expectedVersion: task.version },
        { expectedVersion: task.version, reason: '   ' },
        { expectedVersion: task.version, reason: 'x'.repeat(501) },
      ]) {
        const res = await skipAction(task.id, body);
        assert.strictEqual(res.statusCode, 400, res.body);
        assert.match(JSON.parse(res.body).error, /^reason /);
      }
      const missingVersion = await skipAction(task.id, { reason: 'Not applicable' });
      assert.strictEqual(missingVersion.statusCode, 400);
      assert.strictEqual(JSON.parse(missingVersion.body).error, 'expectedVersion is required');
      const stale = await skipAction(task.id, { expectedVersion: task.version + 5, reason: 'Not applicable' });
      assert.strictEqual(stale.statusCode, 409, stale.body);
      assert.deepStrictEqual(await getTask(client, task.id), task);
    });

    it('completes the Card when its remaining Tasks are done or skipped, and reactivates on unskip', async () => {
      const client = await getClient(port);
      const card = await createCard(client, { ...templateLink(), title: 'Skip completion Card', anchorDate: '2026-05-03', stage: 'announced' });
      const first = await createTask(client, { description: 'Finished', date: '2026-05-03', cardId: card.id });
      const second = await createTask(client, { description: 'Not applicable', date: '2026-05-03', cardId: card.id });
      const finished = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${first.id}`,
        body: JSON.stringify({ status: 'done', expectedVersion: first.version }),
      }, {});
      assert.strictEqual(finished.statusCode, 200, finished.body);
      assert.strictEqual((await getCard(client, card.id))?.status, 'active');

      const skipRes = await skipAction(second.id, { expectedVersion: second.version, reason: 'Cancelled sponsor' });
      assert.strictEqual(skipRes.statusCode, 200, skipRes.body);
      const completed = await getCard(client, card.id);
      assert.deepStrictEqual(
        { status: completed?.status, stage: completed?.stage, openTaskCount: completed?.openTaskCount, taskCount: completed?.taskCount },
        { status: 'archived', stage: 'done', openTaskCount: 0, taskCount: 2 },
      );

      const skipped = JSON.parse(skipRes.body);
      const unskipRes = await skipAction(second.id, { expectedVersion: skipped.version }, 'unskip');
      assert.strictEqual(unskipRes.statusCode, 200, unskipRes.body);
      const unskipped = JSON.parse(unskipRes.body);
      assert.strictEqual(unskipped.status, 'todo');
      assert.strictEqual(unskipped.skipReason, undefined);
      assert.strictEqual(unskipped.skippedAt, undefined);
      assert.strictEqual(unskipped.skippedBy, undefined);
      assert.deepStrictEqual(
        unskipped.taskHistory.map(({ action }: { action: string }) => action),
        ['skipped', 'unskipped'],
      );
      assert.strictEqual(unskipped.taskHistory.at(-1).note, 'Cancelled sponsor');
      const reactivated = await getCard(client, card.id);
      assert.deepStrictEqual(
        { status: reactivated?.status, stage: reactivated?.stage, openTaskCount: reactivated?.openTaskCount },
        { status: 'active', stage: 'announced', openTaskCount: 1 },
      );
    });

    it('skips a waiting Task, clearing its wait, and refuses done or already-skipped Tasks', async () => {
      const client = await getClient(port);
      const waiting = await createTask(client, {
        description: 'Waiting step',
        date: '2026-05-04',
        status: 'waiting',
        waitingFor: 'Speaker reply',
        followUpAt: '2026-05-06',
        followUpChannel: 'email',
        comment: 'Asked',
      });
      const res = await skipAction(waiting.id, { expectedVersion: waiting.version, reason: 'Speaker withdrew' });
      assert.strictEqual(res.statusCode, 200, res.body);
      const skipped = JSON.parse(res.body);
      assert.strictEqual(skipped.status, 'skipped');
      assert.ok(!skipped.waitingFor && !skipped.followUpAt && !skipped.followUpChannel);

      const again = await skipAction(waiting.id, { expectedVersion: skipped.version, reason: 'Again' });
      assert.strictEqual(again.statusCode, 400);
      assert.strictEqual(JSON.parse(again.body).error, 'Task is already skipped');
      const otherAction = await skipAction(waiting.id, {
        expectedVersion: skipped.version,
        waitingFor: 'x',
        followUpAt: '2026-05-08',
        channel: 'email',
        note: 'x',
      }, 'mark-waiting');
      assert.strictEqual(otherAction.statusCode, 400);
      assert.strictEqual(JSON.parse(otherAction.body).error, 'Skipped Tasks must be unskipped before they can be changed');

      const done = await createTask(client, { description: 'Already done', date: '2026-05-04', status: 'done' });
      const doneRes = await skipAction(done.id, { expectedVersion: done.version, reason: 'Late' });
      assert.strictEqual(doneRes.statusCode, 400);
      assert.strictEqual(JSON.parse(doneRes.body).error, 'Completed tasks must be reopened before skipping');

      const open = await createTask(client, { description: 'Open', date: '2026-05-04' });
      const unskipOpen = await skipAction(open.id, { expectedVersion: open.version }, 'unskip');
      assert.strictEqual(unskipOpen.statusCode, 400);
      assert.strictEqual(JSON.parse(unskipOpen.body).error, 'Task is not skipped');
    });

    it('lists skipped Tasks by status', async () => {
      const client = await getClient(port);
      const task = await createTask(client, { description: 'Listed skip', date: '2026-05-05' });
      const res = await skipAction(task.id, { expectedVersion: task.version, reason: 'Duplicate' });
      assert.strictEqual(res.statusCode, 200, res.body);
      const list = await handler({ httpMethod: 'GET', path: '/api/tasks', queryStringParameters: { status: 'skipped' } }, {});
      assert.strictEqual(list.statusCode, 200, list.body);
      assert.ok(JSON.parse(list.body).tasks.some(({ id }: { id: string }) => id === task.id));
    });
  });

  describe('Skipped status through PUT', () => {
    it('rejects a reasonless PUT transition to skipped without mutating the Task', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Archive me', date: '2098-01-01' }),
      }, {});
      const created = JSON.parse(createRes.body);

      const archived = await handler({
        httpMethod: 'PUT',
        path: `/api/tasks/${created.id}`,
        body: JSON.stringify({ status: 'skipped', expectedVersion: created.version }),
      }, {});
      assert.strictEqual(archived.statusCode, 400, archived.body);
      assert.strictEqual(JSON.parse(archived.body).error, 'skipped is set with the skip action, which requires a reason');
      const current = JSON.parse((await handler({
        httpMethod: 'GET',
        path: `/api/tasks/${created.id}`,
      }, {})).body);
      assert.strictEqual(current.status, 'todo');
      assert.strictEqual(current.version, created.version);
    });
  });

  describe('GET /api/tasks/:id with new fields', () => {
    it('returns all new fields when retrieving a task', async () => {
      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Full fields task',
          date: '2026-04-01',
          instructionsUrl: 'https://docs.google.com/howto',
          link: 'https://example.com/link',
          requiredLinkName: 'Example',
          assigneeId: 'user-1',
          tags: ['tag1', 'tag2'],
        }),
      }, {});
      const created = JSON.parse(createRes.body);

      const res = await handler({
        httpMethod: 'GET',
        path: `/api/tasks/${created.id}`,
      }, {});

      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.instructionsUrl, 'https://docs.google.com/howto');
      assert.strictEqual(body.link, 'https://example.com/link');
      assert.strictEqual(body.requiredLinkName, 'Example');
      assert.strictEqual(body.assigneeId, 'user-1');
      assert.deepStrictEqual(body.tags, ['tag1', 'tag2']);
    });
  });

  describe('Full lifecycle of ad hoc task', () => {
    it('create, list, update, mark done, delete', async () => {
      const uniqueDate = '2097-11-11';

      const createRes = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Lifecycle ad hoc task',
          date: uniqueDate,
          comment: 'Initial comment',
        }),
      }, {});
      assert.strictEqual(createRes.statusCode, 201);
      const created = JSON.parse(createRes.body);
      assert.ok(created.id);
      assert.strictEqual(created.source, 'manual');
      assert.strictEqual(created.cardId, undefined);
      assert.strictEqual(created.status, 'todo');
      assert.strictEqual(created.comment, 'Initial comment');

      const listRes = await handler({
        httpMethod: 'GET',
        path: '/api/tasks',
        queryStringParameters: { date: uniqueDate },
      }, {});
      assert.strictEqual(listRes.statusCode, 200);
      const listBody = JSON.parse(listRes.body);
      const found = listBody.tasks.find(function (t: any) { return t.id === created.id; });
      assert.ok(found, 'Ad hoc task should appear in task list');
      assert.strictEqual(found.description, 'Lifecycle ad hoc task');

      const updateRes = await handler({
        httpMethod: 'PUT',
        path: '/api/tasks/' + created.id,
        body: JSON.stringify({ description: 'Updated ad hoc task', expectedVersion: created.version }),
      }, {});
      assert.strictEqual(updateRes.statusCode, 200);
      const updated = JSON.parse(updateRes.body);
      assert.strictEqual(updated.description, 'Updated ad hoc task');

      const doneRes = await handler({
        httpMethod: 'PUT',
        path: '/api/tasks/' + created.id,
        body: JSON.stringify({ status: 'done', expectedVersion: updated.version }),
      }, {});
      assert.strictEqual(doneRes.statusCode, 200);
      const done = JSON.parse(doneRes.body);
      assert.strictEqual(done.status, 'done');

      const getRes = await handler({
        httpMethod: 'GET',
        path: '/api/tasks/' + created.id,
      }, {});
      assert.strictEqual(getRes.statusCode, 200);
      const fetched = JSON.parse(getRes.body);
      assert.strictEqual(fetched.status, 'done');
      assert.strictEqual(fetched.description, 'Updated ad hoc task');

      const deleteRes = await handler({
        httpMethod: 'DELETE',
        path: '/api/tasks/' + created.id,
        body: JSON.stringify({ expectedVersion: done.version }),
      }, {});
      assert.strictEqual(deleteRes.statusCode, 204);

      const goneRes = await handler({
        httpMethod: 'GET',
        path: '/api/tasks/' + created.id,
      }, {});
      assert.strictEqual(goneRes.statusCode, 404);
    });
  });
});
