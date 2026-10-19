// Run only through scripts/test-sponsor-finance-transaction.sh, and only
// after every other file: it fills the bookkeeping table past the 5,000-row
// discovery boundary, which fails closed for every projection after it.
import { before, describe, it } from 'node:test';
import assert from 'node:assert';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createTables, TABLE_BOOKKEEPING } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listFinanceCandidates } from '../src/sponsorFinance/repository';

const key = (prefix: string, id: string) => ({ PK: `${prefix}#${id}`, SK: `${prefix}#${id}` });

describe('discovery fails closed past the evaluated-row boundary', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    assert.ok(process.env.DYNAMODB_ENDPOINT, 'focused harness requires real DynamoDB Local');
    client = await getClient();
    await createTables(client);
  });

  it('fails closed at the real DynamoDB 5,000-evaluated-row discovery boundary', async () => {
    const requests = Array.from({ length: 5_001 }, (_, index) => ({
      PutRequest: {
        Item: {
          ...key('BOUNDARY', `row-${String(index).padStart(5, '0')}`),
          id: `row-${index}`,
        },
      },
    }));
    for (let offset = 0; offset < requests.length; offset += 25) {
      let pending = requests.slice(offset, offset + 25);
      do {
        const result = await client.send(new BatchWriteCommand({
          RequestItems: { [TABLE_BOOKKEEPING]: pending },
        }));
        pending = result.UnprocessedItems?.[TABLE_BOOKKEEPING] || [];
      } while (pending.length);
    }
    await assert.rejects(
      () => listFinanceCandidates(client, { kind: 'transaction', currency: 'EUR', limit: 10 }),
      (error: Error & { statusCode?: number }) => error.statusCode === 503,
    );
  });
});
