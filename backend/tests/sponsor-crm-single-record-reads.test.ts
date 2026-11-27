import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { listBookingHistory } from '../src/db/sponsorCrm';
import { listContractAudit } from '../src/db/sponsorContracts';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';

/** Records every command; Query serves one partition in two pages. */
function recordingClient(rows: Record<string, unknown>[]) {
  const commands: Array<{ name: string; input: Record<string, any> }> = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
      commands.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name !== 'QueryCommand') throw new Error(`unexpected ${command.constructor.name}`);
      const pk = command.input.ExpressionAttributeValues[':pk'];
      const matching = rows.filter((row) => row.PK === pk);
      if (!command.input.ExclusiveStartKey) {
        return { Items: matching.slice(0, 1), ...(matching.length > 1 ? { LastEvaluatedKey: { PK: pk, SK: matching[0].SK } } : {}) };
      }
      return { Items: matching.slice(1) };
    },
  };
  return { client: client as unknown as DynamoDBDocumentClient, commands };
}

describe('sponsor CRM single-record history reads', () => {
  it('queries one deal history partition instead of scanning the table', async () => {
    const { client, commands } = recordingClient([
      { PK: 'HISTORY#deal-1', SK: '2026-01-02#b', id: 'b', createdAt: '2026-01-02' },
      { PK: 'HISTORY#deal-1', SK: '2026-01-01#a', id: 'a', createdAt: '2026-01-01' },
      { PK: 'HISTORY#deal-2', SK: '2026-01-01#c', id: 'c', createdAt: '2026-01-01' },
    ]);
    const history = await listBookingHistory(client, 'deal-1');
    assert.deepEqual(history.map((item) => item.id), ['a', 'b'], 'all pages, oldest first, other partitions excluded');
    assert.equal(history[0].PK, undefined);
    assert.deepEqual(commands.map((command) => command.name), ['QueryCommand', 'QueryCommand']);
    assert.equal(commands[0].input.TableName, TABLE_SPONSOR_CRM);
    assert.equal(commands[0].input.KeyConditionExpression, 'PK = :pk');
    assert.equal(commands[0].input.IndexName, undefined, 'base-table key, no index');
  });

  it('queries one contract history partition', async () => {
    const { client, commands } = recordingClient([
      { PK: 'CONTRACT-HISTORY#c-1', SK: '2026-01-01#a', id: 'a', createdAt: '2026-01-01' },
    ]);
    assert.deepEqual((await listContractAudit(client, 'c-1')).map((item) => item.id), ['a']);
    assert.deepEqual(commands.map((command) => command.name), ['QueryCommand']);
    assert.equal(commands[0].input.ExpressionAttributeValues[':pk'], 'CONTRACT-HISTORY#c-1');
  });
});
