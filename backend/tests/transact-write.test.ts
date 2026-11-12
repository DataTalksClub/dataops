import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { transactWrite } from '../src/db/transactWrite';
import { TABLE_SESSIONS } from '../src/db/tableNames';
import { useTestDatabase } from './helpers/db';

const key = (id: string) => ({ PK: `TXTEST#${id}`, SK: `TXTEST#${id}` });

describe('transactWrite local emulation', () => {
  let client: Awaited<ReturnType<typeof useTestDatabase>>['client'];
  const read = async (id: string) => (await client.send(new GetCommand({
    TableName: TABLE_SESSIONS, Key: key(id), ConsistentRead: true,
  }))).Item;

  before(async () => {
    ({ client } = await useTestDatabase());
  });

  it('applies Put, Update and Delete items together', async () => {
    await client.send(new PutCommand({ TableName: TABLE_SESSIONS, Item: { ...key('a-update'), version: 1 } }));
    await client.send(new PutCommand({ TableName: TABLE_SESSIONS, Item: { ...key('a-delete'), version: 1 } }));
    await transactWrite(client, [
      { Put: { TableName: TABLE_SESSIONS, Item: { ...key('a-put'), version: 1 }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Update: {
        TableName: TABLE_SESSIONS, Key: key('a-update'),
        UpdateExpression: 'ADD #version :one',
        ConditionExpression: '#version = :expected',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':one': 1, ':expected': 1 },
      } },
      { Delete: { TableName: TABLE_SESSIONS, Key: key('a-delete') } },
    ]);
    assert.equal((await read('a-put'))?.version, 1);
    assert.equal((await read('a-update'))?.version, 2);
    assert.equal(await read('a-delete'), undefined);
  });

  it('cancels like DynamoDB and restores earlier items when a later condition fails', async () => {
    await client.send(new PutCommand({ TableName: TABLE_SESSIONS, Item: { ...key('b-kept'), version: 1 } }));
    await client.send(new PutCommand({ TableName: TABLE_SESSIONS, Item: { ...key('b-stale'), version: 5 } }));
    await assert.rejects(
      transactWrite(client, [
        { Put: { TableName: TABLE_SESSIONS, Item: { ...key('b-new'), version: 1 }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE_SESSIONS, Item: { ...key('b-kept'), version: 2 } } },
        { Put: {
          TableName: TABLE_SESSIONS, Item: { ...key('b-stale'), version: 2 },
          ConditionExpression: '#version = :expected',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':expected': 1 },
        } },
      ]),
      (error: Error & { CancellationReasons?: Array<{ Code: string }> }) => {
        assert.equal(error.name, 'TransactionCanceledException');
        assert.deepEqual(error.CancellationReasons?.map(({ Code }) => Code), ['None', 'None', 'ConditionalCheckFailed']);
        return true;
      },
    );
    assert.equal(await read('b-new'), undefined);
    assert.equal((await read('b-kept'))?.version, 1);
    assert.equal((await read('b-stale'))?.version, 5);
  });

  it('restores applied items and rethrows a non-condition failure unchanged', async () => {
    process.env.LOCAL_TRANSACTION_TEST_FAIL_AFTER = '1';
    try {
      await assert.rejects(
        transactWrite(client, [
          { Put: { TableName: TABLE_SESSIONS, Item: { ...key('c-first'), version: 1 } } },
          { Put: { TableName: TABLE_SESSIONS, Item: { ...key('c-second'), version: 1 } } },
        ]),
        /Injected local transaction failure/,
      );
    } finally {
      delete process.env.LOCAL_TRANSACTION_TEST_FAIL_AFTER;
    }
    assert.equal(await read('c-first'), undefined);
    assert.equal(await read('c-second'), undefined);
  });

  it('refuses item kinds it cannot emulate before writing anything', async () => {
    await assert.rejects(
      transactWrite(client, [
        { Put: { TableName: TABLE_SESSIONS, Item: { ...key('d-put'), version: 1 } } },
        { ConditionCheck: { TableName: TABLE_SESSIONS, Key: key('d-put'), ConditionExpression: 'attribute_exists(PK)' } },
      ]),
      /supports only Put, Update and Delete/,
    );
    assert.equal(await read('d-put'), undefined);
  });
});
