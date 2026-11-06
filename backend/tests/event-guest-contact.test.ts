import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, createTables, stopLocal } from '../scripts/local-dynamodb';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { GuestContactInputError, resolveGuestContact } from '../src/events/guestContact';

let client: DynamoDBDocumentClient;
before(async () => { client = await getClient(await startLocal()); await createTables(client); });
after(stopLocal);
async function store(id: string, value: Record<string, unknown>, kind = 'contact') {
  const key = `${kind.toUpperCase()}#${id}`;
  await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: {
    PK: key, SK: key, id, version: 1, createdAt: '2030-01-01', updatedAt: '2030-01-01', ...value,
  } }));
}

test('resolves the private directory person to structured saved email without a scan', async () => {
  await store('saved-person', { name: 'Synthetic Guest', emails: ['Guest@Example.test'] });
  assert.deepEqual(await resolveGuestContact(client, { guestPersonId: 'saved-person' }), {
    name: 'Synthetic Guest', email: 'guest@example.test', reference: { kind: 'contact', id: 'saved-person' },
  });
});

test('a known guest without structured email remains contact pending, never mined from notes', async () => {
  await store('no-email', { name: 'Known Guest', notes: 'email guessed@example.test', linkedin: 'https://example.test/profile' });
  assert.deepEqual(await resolveGuestContact(client, { guestReference: { kind: 'contact', id: 'no-email' } }), {
    name: 'Known Guest', reference: { kind: 'contact', id: 'no-email' },
  });
});

test('accepts explicit email alone or an explicit replacement on a saved contact', async () => {
  assert.deepEqual(await resolveGuestContact(client, { guestEmail: 'New@Example.test' }), { email: 'new@example.test' });
  await store('overridden', { name: 'Saved Name', emails: ['old@example.test'] });
  assert.deepEqual(await resolveGuestContact(client, { guestEmail: 'new@example.test', guestContactId: 'overridden', guestName: 'Given Name' }), {
    email: 'new@example.test', name: 'Given Name', reference: { kind: 'contact', id: 'overridden' },
  });
});

test('rejects unknown, conflicting, inactive and do-not-contact references', async () => {
  await assert.rejects(resolveGuestContact(client, { guestPersonId: 'missing' }), error => error instanceof GuestContactInputError && error.statusCode === 404);
  await assert.rejects(resolveGuestContact(client, { guestPersonId: 'one', guestContactId: 'two' }), /different/);
  await store('inactive', { name: 'Inactive Guest', active: false, emails: ['inactive@example.test'] });
  await assert.rejects(resolveGuestContact(client, { guestContactId: 'inactive' }), /inactive/);
  await store('blocked-company', { doNotContact: true }, 'organization');
  await store('blocked', { name: 'Blocked Guest', organizationId: 'blocked-company', emails: ['blocked@example.test'] });
  await assert.rejects(resolveGuestContact(client, { guestContactId: 'blocked', guestEmail: 'explicit@example.test' }), /do not contact/);
});
