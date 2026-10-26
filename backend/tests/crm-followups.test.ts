import { createUserWithId } from '../src/db/users';
import { setDefaultAssignee } from '../src/db/workspaceSettings';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { createTables } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
const GRACE_USER_ID = '00000000-0000-0000-0000-000000000001';

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const url = new URL(path, 'http://crm-followups.test');
  return handler({
    httpMethod: method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
};
const data = (response: any) => JSON.parse(response.body);

describe('crm direct follow-ups on contacts and companies', () => {
  let client: DynamoDBDocumentClient;
  before(async () => { const port = await startLocal(); client = await getClient(port); await createTables(client); await createUserWithId(client, GRACE_USER_ID, { name: 'Queue Fixture', email: 'queue@example.test', role: 'admin' }); await setDefaultAssignee(client, { defaultAssigneeId: GRACE_USER_ID, expectedVersion: 0 }); });
  after(stopLocal);

  it('stores follow-up date and status directly on a company via create and update', async () => {
    const created = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: 'Direct Followup Co', sourceKey: 'direct-followup-co',
      follow_up_at: '2026-11-05', follow_up_status: 'open', follow_up_note: 'revisit after launch',
    }));
    assert.equal(created.follow_up_at, '2026-11-05');
    assert.equal(created.follow_up_status, 'open');
    assert.equal(created.follow_up_note, 'revisit after launch');

    const badDate = await invoke('PUT', `/api/sponsor-crm/organizations/${created.id}`, { version: created.version, follow_up_at: 'not-a-date' });
    assert.equal(badDate.statusCode, 400);
    const badStatus = await invoke('PUT', `/api/sponsor-crm/organizations/${created.id}`, { version: created.version, follow_up_status: 'someday' });
    assert.equal(badStatus.statusCode, 400);

    const done = data(await invoke('PUT', `/api/sponsor-crm/organizations/${created.id}`, { version: created.version, follow_up_status: 'done' }));
    assert.equal(done.follow_up_status, 'done');
    assert.equal(done.follow_up_at, '2026-11-05');
  });

  it('sets and clears follow-ups on a person through the dedicated endpoint', async () => {
    const org = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Followup Person Org', sourceKey: 'followup-person-org' }));
    const contact = data(await invoke('POST', '/api/sponsor-crm/contacts', {
      organizationId: org.id, name: 'Followup Person', emails: ['followup-person@example.invalid'], sourceKey: 'followup-person',
    }));
    const set = data(await invoke('POST', `/api/sponsor-crm/contacts/${contact.id}/followup`, { follow_up_at: '2026-11-06', follow_up_note: 'ping on launch day' }));
    assert.equal(set.follow_up_at, '2026-11-06');
    assert.equal(set.follow_up_status, 'open');
    assert.equal(set.follow_up_note, 'ping on launch day');

    const bad = await invoke('POST', `/api/sponsor-crm/contacts/${contact.id}/followup`, { follow_up_at: 'tomorrow' });
    assert.equal(bad.statusCode, 400);

    const cleared = data(await invoke('POST', `/api/sponsor-crm/contacts/${contact.id}/followup`, { clear: true }));
    assert.equal(cleared.follow_up_at, null);
    assert.equal(cleared.follow_up_status, null);
  });

  it('lists direct follow-ups, honors due/overdue, and excludes done and do-not-contact', async () => {
    const open = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: 'Open Followup Org', sourceKey: 'open-followup-org', follow_up_at: '2026-10-20', follow_up_status: 'open',
    }));
    const future = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: 'Future Followup Org', sourceKey: 'future-followup-org', follow_up_at: '2026-12-20', follow_up_status: 'open',
    }));
    const settled = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: 'Settled Followup Org', sourceKey: 'settled-followup-org', follow_up_at: '2026-10-10', follow_up_status: 'done',
    }));
    const dnc = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: 'Dnc Followup Org', sourceKey: 'dnc-followup-org', follow_up_at: '2026-10-10', follow_up_status: 'open',
    }));
    await invoke('POST', `/api/sponsor-crm/organizations/${dnc.id}/dnc`, { doNotContact: true });

    const all = data(await invoke('GET', '/api/sponsor-crm/followups'));
    const recordIds = (all.records || []).map((record: any) => record.id);
    assert.ok(recordIds.includes(open.id), 'open direct follow-up is listed');
    assert.ok(recordIds.includes(future.id), 'future direct follow-up is listed without filters');
    assert.ok(!recordIds.includes(settled.id), 'done follow-up is excluded');
    assert.ok(!recordIds.includes(dnc.id), 'do-not-contact is excluded');
    assert.equal(all.total, (all.items || []).length + (all.records || []).length);

    const overdue = data(await invoke('GET', '/api/sponsor-crm/followups?overdue=true'));
    const overdueIds = (overdue.records || []).map((record: any) => record.id);
    assert.ok(!overdueIds.includes(future.id), 'future follow-up is not overdue');

    const due = data(await invoke('GET', '/api/sponsor-crm/followups?due=true'));
    assert.ok((due.records || []).length >= 1, 'due filter returns open direct follow-ups');
  });

  it('projects follow-up fields in the company and people directories', async () => {
    const org = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: 'Directory Followup Org', sourceKey: 'directory-followup-org',
      follow_up_at: '2026-11-07', follow_up_status: 'open', follow_up_note: 'directory check',
    }));
    const contact = data(await invoke('POST', '/api/sponsor-crm/contacts', {
      organizationId: org.id, name: 'Directory Followup Person', emails: ['directory-followup@example.invalid'],
      sourceKey: 'directory-followup-person', follow_up_at: '2026-11-08', follow_up_status: 'open',
    }));

    const companies = data(await invoke('GET', `/api/sponsor-crm/directory/companies?search=${encodeURIComponent('Directory Followup Org')}`));
    const companyRow = (companies.items || []).find((row: any) => row.id === org.id);
    assert.equal(companyRow?.follow_up_at, '2026-11-07');
    assert.equal(companyRow?.follow_up_status, 'open');
    assert.equal(companyRow?.follow_up_note, 'directory check');

    const people = data(await invoke('GET', `/api/sponsor-crm/directory/people?search=${encodeURIComponent('directory-followup@example.invalid')}`));
    const personRow = (people.items || []).find((row: any) => row.id === contact.id);
    assert.equal(personRow?.follow_up_at, '2026-11-08');
    assert.equal(personRow?.follow_up_status, 'open');
  });
});
