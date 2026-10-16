import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createUserWithId } from '../src/db/users';
import { setDefaultAssignee } from '../src/db/workspaceSettings';
import { listAllNotifications } from '../src/db/notifications';

const GRACE_USER_ID = '00000000-0000-0000-0000-000000000001';

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const url = new URL(path, 'http://cold-contacts.test');
  return handler({
    httpMethod: method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
};
const data = (response: any) => JSON.parse(response.body);
const TODAY = '2026-07-01';

describe('sponsor cold contacts', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, GRACE_USER_ID, { name: 'Queue Fixture', email: 'queue@example.test', role: 'admin' });
    await setDefaultAssignee(client, { defaultAssigneeId: GRACE_USER_ID, expectedVersion: 0 });
  });
  after(stopLocal);

  it('lists organizations and contacts quiet past their stage threshold', async () => {
    const stale = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Quiet Corp', domain: 'quiet.example.invalid', lastOutboundAt: '2026-06-01', sourceKey: 'cold-quiet-org' }));
    const fresh = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Fresh Corp', domain: 'fresh.example.invalid', lastOutboundAt: '2026-06-28', sourceKey: 'cold-fresh-org' }));
    const bryce = data(await invoke('POST', '/api/sponsor-crm/contacts', { organizationId: stale.id, name: 'Bryce Mackin', emails: ['bryce@quiet.example.invalid'], lastOutboundAt: '2025-12-04', sourceKey: 'cold-bryce' }));
    const recent = data(await invoke('POST', '/api/sponsor-crm/contacts', { organizationId: stale.id, name: 'Recent Person', emails: ['recent@quiet.example.invalid'], lastOutboundAt: '2026-06-29', sourceKey: 'cold-recent' }));
    assert.ok(bryce.id && recent.id && fresh.id);

    const cold = data(await invoke('GET', `/api/sponsor-crm/cold?today=${TODAY}`));
    assert.deepEqual(cold.thresholds, { talking: 14, customer: 30, prospect: 30, dormant: 90 });
    const ids = cold.items.map((item: any) => item.id);
    assert.ok(ids.includes(stale.id), `stale org missing: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(bryce.id), 'stale contact missing');
    assert.ok(!ids.includes(fresh.id), 'fresh org must not be cold');
    assert.ok(!ids.includes(recent.id), 'fresh contact must not be cold');
    const org = cold.items.find((item: any) => item.id === stale.id);
    assert.equal(org.kind, 'organization');
    assert.equal(org.relationship, 'talking');
    assert.equal(org.daysSince, 30);
    assert.equal(org.threshold, 14);
    const person = cold.items.find((item: any) => item.id === bryce.id);
    assert.equal(person.kind, 'contact');
    assert.ok(person.daysSince > 200, `Bryce quiet since Dec: ${person.daysSince}`);

    const strict = data(await invoke('GET', `/api/sponsor-crm/cold?today=${TODAY}&days=200`));
    assert.ok(!strict.items.map((item: any) => item.id).includes(stale.id), 'override days=200 must clear a 30-day-quiet org');
    assert.ok(strict.items.map((item: any) => item.id).includes(bryce.id), 'override days=200 keeps Bryce');
    assert.equal((await invoke('GET', '/api/sponsor-crm/cold?days=soon')).statusCode, 400);
  });

  it('touches log an outreach, warm the record, and file the message', async () => {
    const org = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Touch Corp', lastOutboundAt: '2026-01-05', sourceKey: 'cold-touch-org' }));
    const person = data(await invoke('POST', '/api/sponsor-crm/contacts', { organizationId: org.id, name: 'Touch Person', emails: ['touch@touch.example.invalid'], lastOutboundAt: '2026-01-05', sourceKey: 'cold-touch-person' }));
    assert.ok(data(await invoke('GET', `/api/sponsor-crm/cold?today=${TODAY}`)).items.some((item: any) => item.id === org.id));

    const touched = await invoke('POST', '/api/sponsor-crm/touches', {
      targetType: 'organization', targetId: org.id, channel: 'email', note: 'check-in', touchedAt: TODAY,
    });
    assert.equal(touched.statusCode, 201, touched.body);
    assert.equal(data(touched).organization.lastOutboundAt, TODAY);
    assert.ok(data(touched).messageId);
    assert.ok(!data(await invoke('GET', `/api/sponsor-crm/cold?today=${TODAY}`)).items.some((item: any) => item.id === org.id));

    const warmed = await invoke('POST', '/api/sponsor-crm/touches', {
      targetType: 'contact', targetId: person.id, channel: 'call', touchedAt: TODAY,
    });
    assert.equal(warmed.statusCode, 201, warmed.body);
    assert.equal(data(warmed).contact.lastOutboundAt, TODAY);
    assert.equal(data(warmed).organization.lastOutboundAt, TODAY);
    const messages = data(await invoke('GET', `/api/sponsor-crm/organizations/${org.id}/messages`)).items;
    assert.ok(messages.some((item: any) => item.sourceType === 'touch' && item.direction === 'outbound'));

    assert.equal((await invoke('POST', '/api/sponsor-crm/touches', { targetType: 'deal', targetId: org.id, channel: 'email' })).statusCode, 400);
    assert.equal((await invoke('POST', '/api/sponsor-crm/touches', { targetType: 'organization', targetId: org.id, channel: 'smoke' })).statusCode, 400);
    assert.equal((await invoke('POST', '/api/sponsor-crm/touches', { targetType: 'organization', targetId: 'missing', channel: 'email' })).statusCode, 404);
  });

  it('reminds once per organization and never duplicates an open reminder', async () => {
    const org = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Remind Corp', lastOutboundAt: '2026-02-01', sourceKey: 'cold-remind-org' }));
    const first = await invoke('POST', '/api/sponsor-crm/cold/remind', { today: TODAY });
    assert.equal(first.statusCode, 201, first.body);
    const created = data(first).created.find((item: any) => item.organizationId === org.id);
    assert.ok(created, `no reminder for the org: ${first.body}`);
    const task = data(await invoke('GET', `/api/tasks/${created.taskId}`));
    assert.equal(task.subject.type, 'sponsor-company');
    assert.equal(task.subject.id, org.id);
    assert.ok((task.tags || []).includes('cold-contact'));

    const second = data(await invoke('POST', '/api/sponsor-crm/cold/remind', { today: TODAY }));
    assert.ok(!second.created.some((item: any) => item.organizationId === org.id), 'an open reminder must not duplicate');
    assert.ok(second.skipped.includes(org.id));
    const notes = await listAllNotifications(client);
    assert.ok(notes.some((note) => (note.metadata as any)?.coldTaskId === created.taskId), 'a cold-contact notification accompanies the Task');
  });

  it('lets an admin tune the per-stage thresholds', async () => {
    const settings = data(await invoke('GET', '/api/workspace-settings'));
    const saved = await invoke('PUT', '/api/workspace-settings', {
      sponsorColdContactDays: { talking: 7, customer: 60, prospect: 365, dormant: 180 },
      expectedVersion: settings.version,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(data(saved).sponsorColdContactDays, { talking: 7, customer: 60, prospect: 365, dormant: 180 });
    const bad = await invoke('PUT', '/api/workspace-settings', {
      sponsorColdContactDays: { talking: 0, customer: 60, prospect: 30, dormant: 90 },
      expectedVersion: data(saved).version,
    });
    assert.equal(bad.statusCode, 400);
  });
});
