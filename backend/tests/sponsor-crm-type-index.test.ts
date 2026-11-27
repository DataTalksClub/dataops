import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, BatchWriteCommand, type DynamoDBDocumentClient as DocClient } from '@aws-sdk/lib-dynamodb';

import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { backfillSponsorCrmEntityType } from '../scripts/backfill-sponsor-crm-entity-type';
import { getClient } from '../src/db/client';
import { createOrganizationAtomic, listCrmItems, listCrmRecords } from '../src/db/sponsorCrm';
import { entityTypeOf, entityTypeOfPrefix, stampSponsorCrmWrite } from '../src/db/sponsorCrmTypeIndex';
import { TABLE_SPONSOR_CRM, TABLE_TASKS } from '../src/db/tableNames';

describe('sponsor CRM type index: stamping', () => {
  it('derives the type from PK for indexed types only', () => {
    assert.equal(entityTypeOf('DEAL#1'), 'DEAL');
    assert.equal(entityTypeOf('NEWSLETTER-ISSUE#1'), 'NEWSLETTER-ISSUE');
    assert.equal(entityTypeOf('SPONSOR_FINANCE_PAYMENT#d#p'), 'SPONSOR_FINANCE_PAYMENT');
    for (const pk of ['HISTORY#deal-1', 'MESSAGE#1', 'MESSAGE_TARGET#deal:1', 'COMMUNICATION#1', 'DEAL_COMMUNICATION#1', 'CONTRACT-HISTORY#1', 'SPONSOR_FINANCE_CLAIM#x', 'DEAL', undefined]) {
      assert.equal(entityTypeOf(pk), undefined, String(pk));
    }
    assert.equal(entityTypeOfPrefix('CONTACT#'), 'CONTACT');
    assert.throws(() => entityTypeOfPrefix('CONTACT'), /not an indexed entity type/);
  });

  it('stamps Put, TransactWrite and BatchWrite items on the CRM table without mutating them', () => {
    const item = { PK: 'DEAL#1', SK: 'DEAL#1', id: '1' };
    const put = new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: item });
    assert.deepEqual(stampSponsorCrmWrite(put), ['DEAL']);
    assert.equal(put.input.Item!.GSI5PK, 'DEAL');
    assert.equal((item as Record<string, unknown>).GSI5PK, undefined, 'caller object untouched');

    const transact = new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: TABLE_SPONSOR_CRM, Item: { PK: 'CONTACT#1', SK: 'CONTACT#1' } } },
      { Put: { TableName: TABLE_SPONSOR_CRM, Item: { PK: 'HISTORY#contact:1', SK: 'x' } } },
      { Put: { TableName: TABLE_TASKS, Item: { PK: 'DEAL#elsewhere', SK: 'x' } } },
      { Update: { TableName: TABLE_SPONSOR_CRM, Key: { PK: 'ORGANIZATION#1', SK: 'ORGANIZATION#1' }, UpdateExpression: 'ADD version :one' } },
    ] });
    assert.deepEqual(stampSponsorCrmWrite(transact), ['CONTACT', 'ORGANIZATION']);
    const items = transact.input.TransactItems!;
    assert.equal(items[0].Put!.Item!.GSI5PK, 'CONTACT');
    assert.equal(items[1].Put!.Item!.GSI5PK, undefined, 'history stays out of the sparse index');
    assert.equal(items[2].Put!.Item!.GSI5PK, undefined, 'other tables are untouched');

    const batch = new BatchWriteCommand({ RequestItems: { [TABLE_SPONSOR_CRM]: [{ PutRequest: { Item: { PK: 'LEAD#1', SK: 'LEAD#1' } } }] } });
    stampSponsorCrmWrite(batch);
    assert.equal(batch.input.RequestItems![TABLE_SPONSOR_CRM][0].PutRequest!.Item!.GSI5PK, 'LEAD');
  });
});

describe('sponsor CRM type index: storage', () => {
  let client: DocClient;
  let raw: DocClient;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    // A client without the stamping wrapper stands in for rows written before
    // the index existed.
    raw = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: 'us-east-1', endpoint: `http://127.0.0.1:${port}`, credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }));
  });
  after(stopLocal);

  it('lists a type through the index and never returns other row kinds', async () => {
    const { item } = await createOrganizationAtomic(client, { displayName: 'Indexed Org' }, 'tester');
    const stored = (await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: `ORGANIZATION#${item.id}`, SK: `ORGANIZATION#${item.id}` } }))).Item!;
    assert.equal(stored.GSI5PK, 'ORGANIZATION');
    const organizations = await listCrmRecords(client, 'organization');
    assert.ok(organizations.some((org) => org.id === item.id));
    assert.ok(organizations.every((org) => org.GSI5PK === undefined));
    assert.ok((await listCrmItems(client, 'CONTACT#')).every((row) => String(row.PK).startsWith('CONTACT#')));
  });

  it('backfill is a dry run by default, stamps legacy rows on apply, and is idempotent', async () => {
    await raw.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { PK: 'DEAL#legacy-1', SK: 'DEAL#legacy-1', id: 'legacy-1', version: 1, createdAt: 'x', updatedAt: 'x' } }));
    await raw.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { PK: 'CONTACT#legacy-2', SK: 'CONTACT#legacy-2', id: 'legacy-2', version: 3, createdAt: 'x', updatedAt: 'x' } }));
    await raw.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { PK: 'HISTORY#legacy-1', SK: 'h1', id: 'h1' } }));
    assert.ok(!(await listCrmRecords(client, 'deal')).some((deal) => deal.id === 'legacy-1'), 'unstamped rows are not listed');

    const dryRun = await backfillSponsorCrmEntityType(client, { apply: false });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.planned, 2);
    assert.deepEqual(dryRun.byType, { DEAL: 1, CONTACT: 1 });
    assert.equal(dryRun.applied, 0);
    assert.equal((await raw.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: 'DEAL#legacy-1', SK: 'DEAL#legacy-1' } }))).Item!.GSI5PK, undefined, 'dry run writes nothing');

    const applied = await backfillSponsorCrmEntityType(client, { apply: true });
    assert.equal(applied.applied, 2);
    const contact = (await raw.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: 'CONTACT#legacy-2', SK: 'CONTACT#legacy-2' } }))).Item!;
    assert.equal(contact.GSI5PK, 'CONTACT');
    assert.equal(contact.version, 3, 'backfill never bumps the record version');
    const history = (await raw.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: 'HISTORY#legacy-1', SK: 'h1' } }))).Item!;
    assert.equal(history.GSI5PK, undefined);
    assert.ok((await listCrmRecords(client, 'deal')).some((deal) => deal.id === 'legacy-1'));

    const again = await backfillSponsorCrmEntityType(client, { apply: true });
    assert.equal(again.planned, 0);
    assert.equal(again.applied, 0);
  });
});
