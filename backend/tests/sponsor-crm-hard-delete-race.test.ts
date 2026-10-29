import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import {
  createContactAtomic, createCrmRecord, createDealAtomic, createOrganizationAtomic,
  getCrmRecord, hardDeleteCrmRecord, updateContactAtomic,
} from '../src/db/sponsorCrm';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { createNote, queryTargetNotes } from '../src/crmWorkspace/notes';
import { touchTarget } from '../src/sponsorCrm/coldContacts';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';

/** Insert a real dependency after the guard scan has taken its snapshot. */
function afterScan(client: DynamoDBDocumentClient, write: () => Promise<unknown>) {
  let injected = false;
  return {
    send: async (command: unknown, ...args: unknown[]) => {
      const result = await (client.send as any)(command, ...args);
      if (command instanceof ScanCommand && !injected) {
        injected = true;
        await write();
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
}

describe('CRM hard-delete dependency races', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    if (process.env.CRM_HARD_DELETE_DDB === '1') {
      assert.equal(new URL(process.env.DYNAMODB_ENDPOINT!).hostname, '127.0.0.1', 'native transaction tests require loopback DynamoDB Local');
      client = await getClient();
    } else {
      client = await getClient(await startLocal());
    }
    await createTables(client);
  });
  after(stopLocal);

  it('preserves an organization when a contact is committed after the guard snapshot', async () => {
    const { item: organization } = await createOrganizationAtomic(client, { displayName: 'Concurrent contact fixture' }, 'test');
    let contactId = '';
    const racingClient = afterScan(client, async () => {
      const { item } = await createContactAtomic(client, { organizationId: organization.id, name: 'Concurrent person' }, 'test');
      contactId = item.id;
    });

    await assert.rejects(hardDeleteCrmRecord(racingClient, 'organization', organization.id));
    assert.ok(await getCrmRecord(client, 'organization', organization.id));
    assert.equal((await getCrmRecord(client, 'contact', contactId))?.organizationId, organization.id);
  });

  it('preserves human notes committed after the guard snapshot', async () => {
    const { item: organization } = await createOrganizationAtomic(client, { displayName: 'Concurrent note fixture' }, 'test');
    const racingClient = afterScan(client, async () => {
      const result = await createNote(client, 'test-author', 'organization', organization.id, { body: 'Human note added during deletion' });
      assert.equal(result.status, 201);
    });

    await assert.rejects(hardDeleteCrmRecord(racingClient, 'organization', organization.id));
    assert.ok(await getCrmRecord(client, 'organization', organization.id));
    assert.equal((await queryTargetNotes(client, 'organization', organization.id)).items.length, 1);
  });

  it('preserves a contact linked by a deal after the guard snapshot', async () => {
    const { item: organization } = await createOrganizationAtomic(client, { displayName: 'Concurrent deal fixture' }, 'test');
    const { item: contact } = await createContactAtomic(client, { organizationId: organization.id, name: 'Deal contact' }, 'test');
    const racingClient = afterScan(client, () => createDealAtomic(client, { organizationId: organization.id, primaryContactId: contact.id, status: 'open' }, 'test'));
    await assert.rejects(hardDeleteCrmRecord(racingClient, 'contact', contact.id));
    assert.ok(await getCrmRecord(client, 'contact', contact.id));
  });

  it('preserves an organization when an existing contact moves into it during deletion', async () => {
    const { item: source } = await createOrganizationAtomic(client, { displayName: 'Source company' }, 'test');
    const { item: target } = await createOrganizationAtomic(client, { displayName: 'Target company' }, 'test');
    const { item: contact } = await createContactAtomic(client, { organizationId: source.id, name: 'Moving contact' }, 'test');
    const racingClient = afterScan(client, () => updateContactAtomic(client, contact, { organizationId: target.id }, 'test'));
    await assert.rejects(hardDeleteCrmRecord(racingClient, 'organization', target.id));
    assert.ok(await getCrmRecord(client, 'organization', target.id));
    assert.equal((await getCrmRecord(client, 'contact', contact.id))?.organizationId, target.id);
  });

  it('refuses late dependency writes atomically after the target has been deleted', async () => {
    const { item: organization } = await createOrganizationAtomic(client, { displayName: 'Deleted parent' }, 'test');
    await hardDeleteCrmRecord(client, 'organization', organization.id);
    const beforeRows = (await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items;
    await assert.rejects(createContactAtomic(client, { organizationId: organization.id, primary: true, name: 'Too late' }, 'test'));
    const note = createNote(client, 'test', 'organization', organization.id, { body: 'Too late' });
    assert.equal((await note).status, 404);
    assert.deepEqual((await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items, beforeRows);
  });

  it('does not recreate deleted target indexes on idempotent message replay', async () => {
    const { item: organization } = await createOrganizationAtomic(client, { displayName: 'Message parent' }, 'test');
    const value = { organizationId: organization.id, sourceKey: `replay:${organization.id}`, sourceType: 'gmail', sentAt: '2026-10-29T12:00:00Z' };
    const created = await createCrmRecord(client, 'message', value);
    await hardDeleteCrmRecord(client, 'organization', organization.id);
    const replayed = await createCrmRecord(client, 'message', value);
    assert.equal(replayed.duplicate, true);
    assert.equal(replayed.item.id, created.item.id);
    assert.ok(!(await client.send(new ScanCommand({ TableName: TABLE_SPONSOR_CRM }))).Items!.some(row => row.PK === `MESSAGE_TARGET#organization:${organization.id}`));
  });

  it('returns the committed target versions after filing a touch message', async () => {
    const { item: organization } = await createOrganizationAtomic(client, { displayName: 'Touch company' }, 'test');
    const { item: contact } = await createContactAtomic(client, { organizationId: organization.id, name: 'Touch contact' }, 'test');
    for (const target of [{ targetType: 'organization' as const, targetId: organization.id }, { targetType: 'contact' as const, targetId: contact.id }]) {
      const result = await touchTarget(client, target, { actorId: 'test', channel: 'call', touchedAt: '2026-10-29T12:00:00Z' });
      assert.equal(result.organization.version, (await getCrmRecord(client, 'organization', organization.id))?.version);
      if (result.contact) assert.equal(result.contact.version, (await getCrmRecord(client, 'contact', contact.id))?.version);
    }
  });
});
