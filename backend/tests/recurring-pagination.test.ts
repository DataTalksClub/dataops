import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  listEnabledRecurringConfigs,
  listRecurringConfigs,
  listRecurringRuns,
} from '../src/db/recurring';

/**
 * A filtered Scan applies its filter after DynamoDB's 1 MB page limit, so on a
 * Tasks table larger than one page the matching recurring items can sit on a
 * later page while the first page comes back empty.
 */
function pagedClient(match: Record<string, unknown>, calls: Array<Record<string, unknown>>): DynamoDBDocumentClient {
  const pages = [
    { Items: [], LastEvaluatedKey: { PK: 'TASK#x', SK: 'TASK#x' } },
    { Items: [match] },
  ];
  return {
    async send(command: { input: Record<string, unknown> }) {
      calls.push(command.input);
      const page = pages[calls.length - 1];
      if (!page) throw new Error('Unexpected extra DynamoDB page');
      return page;
    },
  } as unknown as DynamoDBDocumentClient;
}

describe('recurring reads scan every page of the Tasks table', () => {
  const config = { PK: 'RECURRING#c1', SK: 'RECURRING#c1', id: 'c1', enabled: true };
  const run = { PK: 'RECURRINGRUN#c1#2026-10-15', SK: 'RECURRINGRUN#c1#2026-10-15', configId: 'c1', date: '2026-10-15' };

  for (const [label, item, read] of [
    ['configs', config, (client: DynamoDBDocumentClient) => listRecurringConfigs(client)],
    ['enabled configs', config, (client: DynamoDBDocumentClient) => listEnabledRecurringConfigs(client)],
    ['runs', run, (client: DynamoDBDocumentClient) => listRecurringRuns(client, 'c1')],
  ] as const) {
    it(`finds ${label} past an empty first page`, async () => {
      const calls: Array<Record<string, unknown>> = [];
      const items = await read(pagedClient(item, calls));
      assert.strictEqual(items.length, 1);
      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(calls[1].ExclusiveStartKey, { PK: 'TASK#x', SK: 'TASK#x' });
    });
  }
});
