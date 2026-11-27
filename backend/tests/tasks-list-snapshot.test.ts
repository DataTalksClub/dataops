import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTask } from '../src/db/tasks';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';

type Page = { tasks: Array<{ id: string }>; nextCursor?: string };

/**
 * Continuation pages of GET /api/tasks used to re-run the whole source read
 * (Query or Scan) and slice it at the cursor offset. They now page through
 * the first page's matching Tasks, cached per Lambda container.
 */
describe('GET /api/tasks continuation pages', () => {
  let handler: typeof import('../src/handler').handler;
  const date = '2031-04-02';
  const ids: string[] = [];
  let dateQueries = 0;
  const originalSend = DynamoDBDocumentClient.prototype.send;

  before(async () => {
    const port = await startLocal();
    const client = await getClient(port);
    await createTables(client);
    for (let index = 0; index < 5; index += 1) {
      ids.push((await createTask(client, { description: `Paged ${index}`, date })).id);
    }
    ids.sort();
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
    DynamoDBDocumentClient.prototype.send = function send(this: DynamoDBDocumentClient, command: unknown, ...rest: unknown[]) {
      if (command instanceof QueryCommand && command.input.IndexName === 'GSI-Date') dateQueries += 1;
      return (originalSend as (...args: unknown[]) => unknown).call(this, command, ...rest);
    } as typeof originalSend;
  });

  after(async () => {
    DynamoDBDocumentClient.prototype.send = originalSend;
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  async function page(cursor?: string): Promise<Page> {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tasks',
      queryStringParameters: { date, limit: '2', ...(cursor ? { cursor } : {}) },
    }, {});
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as Page;
  }

  it('reads the source once and serves later pages from the first page snapshot', async () => {
    dateQueries = 0;
    const first = await page();
    assert.equal(dateQueries, 1);
    const second = await page(first.nextCursor);
    const third = await page(second.nextCursor);

    assert.equal(dateQueries, 1, 'continuation pages must not re-read the source');
    assert.equal(third.nextCursor, undefined);
    assert.deepEqual([...first.tasks, ...second.tasks, ...third.tasks].map((task) => task.id), ids);
  });

  it('always reads a first page fresh', async () => {
    const first = await page();
    assert.ok(first.nextCursor);
    dateQueries = 0;
    await page();
    assert.equal(dateQueries, 1);
  });

  it('re-reads the source when the snapshot has expired', async () => {
    const first = await page();
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      dateQueries = 0;
      const second = await page(first.nextCursor);
      assert.equal(dateQueries, 1);
      assert.deepEqual(second.tasks.map((task) => task.id), ids.slice(2, 4));
    } finally {
      Date.now = realNow;
    }
  });
});
