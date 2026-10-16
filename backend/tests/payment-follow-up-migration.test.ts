import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { createTask, getTask } from '../src/db/tasks';
import type { LambdaResponse } from '../src/types';

function invoke(body: unknown): Promise<LambdaResponse> {
  return handler({
    httpMethod: 'POST',
    path: '/api/admin/payment-follow-up-migration',
    headers: { 'x-user-id': 'operator-payment-follow-up-migration' },
    body: JSON.stringify(body),
  }, {});
}

const row = (client: DynamoDBDocumentClient, PK: string, SK = PK) =>
  client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK, SK } })).then((result) => result.Item!);

describe('Payment follow-up migration', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('renames the stored chase fields, event codes, tag and generated descriptions', async () => {
    const generated = await createTask(client, {
      description: 'Chase payment from Synthetic Sponsor. 1000 EUR outstanding. Check the linked payment evidence and the ledger for anything already received before chasing — record what you verified and the outcome before resolving this Task.',
      date: '2026-10-16',
      status: 'todo',
      source: 'sponsor-finance',
      tags: ['payment-chase'],
    });
    const manual = await createTask(client, { description: 'Chase the signed order form', date: '2026-10-16', status: 'todo' });
    const put = (Item: Record<string, unknown>) => client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item }));
    await put({ PK: 'SPONSOR_FINANCE#deal-1', SK: 'SPONSOR_FINANCE#deal-1', recordType: 'sponsor-finance', dealId: 'deal-1', version: 4, chaseTaskIds: [generated.id] });
    await put({ PK: 'SPONSOR_FINANCE_HISTORY#deal-1', SK: 'h1', id: 'h1', recordType: 'sponsor-finance-history', dealId: 'deal-1', eventCode: 'chase-task-linked' });
    await put({ PK: 'SPONSOR_FINANCE_HISTORY#deal-1', SK: 'h2', id: 'h2', recordType: 'sponsor-finance-history', dealId: 'deal-1', eventCode: 'invoice-issued' });
    await put({ PK: 'SPONSOR_FINANCE_RECEIPT#r1', SK: 'SPONSOR_FINANCE_RECEIPT#r1', id: 'r1', recordType: 'sponsor-finance-receipt', dealId: 'deal-1', operation: 'chase-task' });

    const dryRun = await invoke({ apply: false });
    assert.equal(dryRun.statusCode, 200);
    const plan = JSON.parse(dryRun.body);
    assert.deepEqual(plan.counts, { finance: 1, history: 1, receipt: 1, task: 1 });
    assert.deepEqual((await row(client, 'SPONSOR_FINANCE#deal-1')).chaseTaskIds, [generated.id], 'a dry run writes nothing');

    const applied = await invoke({ apply: true });
    assert.equal(applied.statusCode, 200, applied.body);
    const finance = await row(client, 'SPONSOR_FINANCE#deal-1');
    assert.deepEqual(finance.paymentFollowUpTaskIds, [generated.id]);
    assert.equal(finance.chaseTaskIds, undefined);
    assert.equal(finance.version, 4);
    assert.equal((await row(client, 'SPONSOR_FINANCE_HISTORY#deal-1', 'h1')).eventCode, 'payment-follow-up-task-linked');
    assert.equal((await row(client, 'SPONSOR_FINANCE_HISTORY#deal-1', 'h2')).eventCode, 'invoice-issued');
    assert.equal((await row(client, 'SPONSOR_FINANCE_RECEIPT#r1')).operation, 'payment-follow-up-task');
    const task = await getTask(client, generated.id);
    assert.deepEqual(task!.tags, ['payment-follow-up']);
    assert.match(task!.description, /^Follow up on the payment from Synthetic Sponsor\. 1000 EUR outstanding\./);
    assert.match(task!.description, / before following up — record /);
    assert.equal((await getTask(client, manual.id))!.description, 'Chase the signed order form');

    const rerun = JSON.parse((await invoke({ apply: false })).body);
    assert.deepEqual(rerun.counts, {});
  });
});
