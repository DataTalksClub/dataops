import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  listTasksByCard,
  listTasksByDate,
  listTasksByDateRange,
  listTasksByStatus,
} from '../src/db/tasks';

interface RecordedCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * DynamoDB ends every Query/Scan page at 1 MB and returns LastEvaluatedKey.
 * Production listed 448 of 684 open Tasks because only the first page was read.
 */
function pagedClient(calls: RecordedCall[]): DynamoDBDocumentClient {
  const pages = [
    { Items: [{ PK: 'TASK#a', SK: 'TASK#a', id: 'a', version: 1, taskHistory: [] }], LastEvaluatedKey: { PK: 'TASK#a', SK: 'TASK#a' } },
    { Items: [], LastEvaluatedKey: { PK: 'TASK#x', SK: 'TASK#x' } },
    { Items: [{ PK: 'TASK#b', SK: 'TASK#b', id: 'b', version: 1, taskHistory: [] }] },
  ];
  return {
    async send(command: { constructor: Function; input: Record<string, unknown> }) {
      calls.push({ name: command.constructor.name, input: command.input });
      const page = pages[calls.length - 1];
      if (!page) throw new Error('Unexpected extra DynamoDB page');
      return page;
    },
  } as unknown as DynamoDBDocumentClient;
}

const listings: Array<[string, string, (client: DynamoDBDocumentClient) => Promise<Array<{ id: string }>>]> = [
  ['status', 'QueryCommand', (client) => listTasksByStatus(client, 'todo')],
  ['date', 'QueryCommand', (client) => listTasksByDate(client, '2026-10-15')],
  ['card', 'QueryCommand', (client) => listTasksByCard(client, 'card-1')],
];

describe('Task listings read every DynamoDB page', () => {
  for (const [label, commandName, list] of listings) {
    it(`by ${label}`, async () => {
      const calls: RecordedCall[] = [];
      const tasks = await list(pagedClient(calls));

      assert.deepStrictEqual(tasks.map((task) => task.id), ['a', 'b']);
      assert.strictEqual(calls.length, 3);
      assert.ok(calls.every((call) => call.name === commandName));
      assert.strictEqual(calls[0].input.ExclusiveStartKey, undefined);
      assert.deepStrictEqual(calls[1].input.ExclusiveStartKey, { PK: 'TASK#a', SK: 'TASK#a' });
      assert.deepStrictEqual(calls[2].input.ExclusiveStartKey, { PK: 'TASK#x', SK: 'TASK#x' });
    });
  }
});

describe('Date-range listing', () => {
  it('runs one ranged GSI-Status Query per status instead of a table Scan', async () => {
    const calls: RecordedCall[] = [];
    const client = {
      async send(command: { constructor: Function; input: Record<string, unknown> }) {
        calls.push({ name: command.constructor.name, input: command.input });
        const status = (command.input.ExpressionAttributeValues as Record<string, string>)[':status'];
        return { Items: [{ PK: `TASK#${status}`, SK: `TASK#${status}`, id: status, status, version: 1, taskHistory: [] }] };
      },
    } as unknown as DynamoDBDocumentClient;

    const tasks = await listTasksByDateRange(client, '2026-10-01', '2026-10-31');

    assert.deepStrictEqual(tasks.map((task) => task.id).sort(), ['done', 'skipped', 'todo', 'waiting']);
    assert.ok(calls.every((call) => call.name === 'QueryCommand' && call.input.IndexName === 'GSI-Status'));
    assert.ok(calls.every((call) => /BETWEEN :start AND :end/.test(String(call.input.KeyConditionExpression))));
    assert.ok(calls.every((call) => !call.input.ConsistentRead));
  });
});
