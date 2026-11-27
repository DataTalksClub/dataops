import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTask } from '../src/db/tasks';
import { TABLE_TASKS } from '../src/db/tableNames';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';

/**
 * Global search used to list every full Task through a 2000-2100 date range
 * on every query. GET /api/tasks/search matches server-side against a
 * cached projection of the few fields search shows.
 */
describe('GET /api/tasks/search', () => {
  let handler: typeof import('../src/handler').handler;
  const taskScans: ScanCommand[] = [];
  const originalSend = DynamoDBDocumentClient.prototype.send;

  before(async () => {
    const port = await startLocal();
    const client = await getClient(port);
    await createTables(client);
    await createTask(client, { description: 'Send sponsor invoice', date: '2031-05-01', comment: 'long note' });
    await createTask(client, { description: 'Invoice follow-up', date: '2031-06-01' });
    await createTask(client, { description: 'Book podcast guest', date: '2031-05-02' });
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
    DynamoDBDocumentClient.prototype.send = function send(this: DynamoDBDocumentClient, command: unknown, ...rest: unknown[]) {
      if (command instanceof ScanCommand && command.input.TableName === TABLE_TASKS) taskScans.push(command);
      return (originalSend as (...args: unknown[]) => unknown).call(this, command, ...rest);
    } as typeof originalSend;
  });

  after(async () => {
    DynamoDBDocumentClient.prototype.send = originalSend;
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  const search = (queryStringParameters: Record<string, string>) => handler({
    httpMethod: 'GET', path: '/api/tasks/search', queryStringParameters,
  }, {});

  it('returns only matching Tasks as projected search rows, newest first', async () => {
    const res = await search({ q: 'INVOICE' });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { tasks: Array<Record<string, unknown>>; total: number };

    assert.equal(body.total, 2);
    assert.deepEqual(body.tasks.map((task) => task.description), ['Invoice follow-up', 'Send sponsor invoice']);
    for (const task of body.tasks) {
      assert.deepEqual(Object.keys(task).sort(), ['date', 'description', 'id', 'status']);
    }
    assert.equal(taskScans.length, 1);
    assert.match(String(taskScans[0].input.ProjectionExpression), /description/);
    assert.doesNotMatch(String(taskScans[0].input.ProjectionExpression), /taskHistory/);
  });

  it('serves later queries from the cached projection', async () => {
    const res = await search({ q: 'podcast', limit: '1' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).tasks.map((task: { description: string }) => task.description), ['Book podcast guest']);
    assert.equal(taskScans.length, 1);
  });

  it('drops the cache when a Task is written in this container', async () => {
    const created = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description: 'Freshly created invoice task', date: '2031-07-01' }),
    }, {});
    assert.equal(created.statusCode, 201, created.body);
    const res = await search({ q: 'freshly created' });
    assert.equal(JSON.parse(res.body).total, 1);
    assert.equal(taskScans.length, 2);
  });

  it('rejects a missing query or an out-of-range limit', async () => {
    assert.equal((await search({})).statusCode, 400);
    assert.equal((await search({ q: 'x', limit: '0' })).statusCode, 400);
    assert.equal((await search({ q: 'x', limit: '201' })).statusCode, 400);
  });
});
