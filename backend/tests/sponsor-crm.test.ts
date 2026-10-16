import { createUserWithId } from '../src/db/users';
import { setDefaultAssignee } from '../src/db/workspaceSettings';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { handler } from '../src/handler';
import { createTables } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createSession } from '../src/db/sessions';
import { evaluateSponsorBookingAlerts } from '../src/sponsorCrm/alerts';
import { listAllNotifications } from '../src/db/notifications';
import { createOrganizationAtomic, deterministicCrmId, listBookingHistory } from '../src/db/sponsorCrm';
const GRACE_USER_ID = '00000000-0000-0000-0000-000000000001';

const IMPORT_FIXTURE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sponsor-crm-import.json'), 'utf8'));

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const url = new URL(path, 'http://sponsor-crm.test');
  return handler({
    httpMethod: method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
};
const data = (response: any) => JSON.parse(response.body);

describe('sponsor CRM', () => {
  let client: DynamoDBDocumentClient;
  before(async () => { const port = await startLocal(); client = await getClient(port); await createTables(client); await createUserWithId(client, GRACE_USER_ID, { name: 'Queue Fixture', email: 'queue@example.test', role: 'admin' }); await setDefaultAssignee(client, { defaultAssigneeId: GRACE_USER_ID, expectedVersion: 0 }); });
  after(stopLocal);

  it('rolls back organization create, update and archive when audit transaction fails', async () => {
    process.env.SPONSOR_CRM_TEST_FAIL_AFTER = '1';
    try {
      const sourceKey = 'rollback-org-create', id = deterministicCrmId('organization', sourceKey);
      const failedCreate = await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Rollback Create', sourceKey });
      assert.equal(failedCreate.statusCode, 500);
      assert.equal((await invoke('GET', `/api/sponsor-crm/organizations/${id}`)).statusCode, 404);
      assert.deepEqual(await listBookingHistory(client, `organization:${id}`), []);
      delete process.env.SPONSOR_CRM_TEST_FAIL_AFTER;
      const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Rollback Existing', sourceKey: 'rollback-org-existing' }));
      assert.equal((await listBookingHistory(client, `organization:${organization.id}`)).length, 1);
      process.env.SPONSOR_CRM_TEST_FAIL_AFTER = '1';
      const failedUpdate = await invoke('PUT', `/api/sponsor-crm/organizations/${organization.id}`, { version: organization.version, displayName: 'Must Roll Back' });
      assert.equal(failedUpdate.statusCode, 500);
      let stored = data(await invoke('GET', `/api/sponsor-crm/organizations/${organization.id}`));
      assert.equal(stored.displayName, 'Rollback Existing');
      assert.equal(stored.version, 1);
      const failedArchive = await invoke('DELETE', `/api/sponsor-crm/organizations/${organization.id}`);
      assert.equal(failedArchive.statusCode, 500);
      stored = data(await invoke('GET', `/api/sponsor-crm/organizations/${organization.id}`));
      assert.equal(stored.archivedAt, undefined);
    } finally { delete process.env.SPONSOR_CRM_TEST_FAIL_AFTER; }
  });

  it('uses one production transaction for organization and audit creation', async () => {
    const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production'; let command: any;
    const fake = { send: async (input: any) => { command = input; return {}; } } as any;
    try {
      await createOrganizationAtomic(fake, { displayName: 'Synthetic transaction proof' }, 'synthetic-actor');
      assert.equal(command.constructor.name, 'TransactWriteCommand');
      assert.ok(command.input.TransactItems.length >= 2);
    } finally { process.env.NODE_ENV = previous; }
  });

  it('enforces auth without leaking contact data', async () => {
    process.env.SKIP_AUTH = 'false';
    const denied = await invoke('GET', '/api/sponsor-crm/contacts');
    assert.equal(denied.statusCode, 401);
    assert.deepEqual(data(denied), { error: 'Unauthorized' });
    process.env.SKIP_AUTH = 'true';
  });

  it('creates idempotent organizations and rejects conflicting reuse', async () => {
    const input = { displayName: 'Synthetic Sponsor', notes: 'Private synthetic note', sourceKey: 'fixture-org' };
    let response = await invoke('POST', '/api/sponsor-crm/organizations', input);
    assert.equal(response.statusCode, 201);
    const first = data(response);
    response = await invoke('POST', '/api/sponsor-crm/organizations', input);
    assert.equal(response.statusCode, 200);
    assert.equal(data(response).id, first.id);
    response = await invoke('POST', '/api/sponsor-crm/organizations', { ...input, displayName: 'Different' });
    assert.equal(response.statusCode, 409);
  });

  it('maintains deals, deliverables, versions and immutable status history', async () => {
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'History Sponsor', sourceKey: 'history-org' }));
    const contact = data(await invoke('POST', '/api/sponsor-crm/contacts', { organizationId: organization.id, name: 'Synthetic Contact', emails: ['operator@example.invalid'], primary: true, sourceKey: 'history-contact' }));
    const created = await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, primaryContactId: contact.id, status: 'open', sourceKey: 'history-deal', historyNote: 'Synthetic create context' });
    assert.equal(created.statusCode, 201, created.body);
    const deal = data(created);
    assert.equal(deal.historyNote, undefined);
    assert.equal(deal.status, 'open');
    let history = data(await invoke('GET', `/api/sponsor-crm/deals/${deal.id}/history`)).items;
    assert.equal(history[0].note, 'Synthetic create context');
    const updated = await invoke('PUT', `/api/sponsor-crm/deals/${deal.id}`, { version: deal.version, status: 'agreed', historyNote: 'Synthetic confirmation' });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(data(updated).version, 2);
    assert.equal((await invoke('PUT', `/api/sponsor-crm/deals/${deal.id}`, { version: 1, status: 'lost' })).statusCode, 409);
    history = data(await invoke('GET', `/api/sponsor-crm/deals/${deal.id}/history`)).items;
    assert.deepEqual(history.map((event: any) => event.newStatus), ['open', 'agreed']);
    assert.equal(JSON.stringify(history).includes('operator@example.invalid'), false);
    const slot = data(await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'main', plannedPublicationDate: '2026-08-20', materialDeadline: '2026-08-10', sourceKey: 'history-slot' }));
    assert.equal(slot.channel, 'main');
    const fetched = data(await invoke('GET', `/api/sponsor-crm/deals/${deal.id}`));
    assert.equal(fetched.fulfillment, 'in-delivery');
    assert.equal(fetched.money, 'none');
  });

  it('needs no next action on a live deal and lists its open Tasks earliest first', async () => {
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Task Sponsor', sourceKey: 'task-org' }));
    const created = await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, status: 'open', sourceKey: 'task-deal' });
    assert.equal(created.statusCode, 201, created.body);
    const deal = data(created);
    assert.equal(deal.rotting, undefined);
    const task = async (description: string, date: string, status?: string) => {
      const response = await invoke('POST', '/api/tasks', { description, date, ...(status ? { status } : {}), subject: { type: 'sponsor-deal', id: deal.id } });
      assert.equal(response.statusCode, 201, response.body);
    };
    await task('Send the invoice', '2026-08-10');
    await task('Confirm the date', '2026-08-01');
    await task('Already done', '2026-07-01', 'done');
    const fetched = data(await invoke('GET', `/api/sponsor-crm/deals/${deal.id}`));
    assert.deepEqual(fetched.openTasks.map((item: any) => [item.description, item.date]), [
      ['Confirm the date', '2026-08-01'],
      ['Send the invoice', '2026-08-10'],
    ]);
    const listed = data(await invoke('GET', '/api/sponsor-crm/deals?limit=100')).items.find((item: any) => item.id === deal.id);
    assert.equal(listed.openTasks.length, 2);
  });

  it('derives money and finance chores from the sponsor finance state', async () => {
    const previous = process.env.SPONSOR_FINANCE_ENABLED;
    process.env.SPONSOR_FINANCE_ENABLED = 'true';
    try {
      const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Money Sponsor', lastOutboundAt: '2026-06-20', lastInboundAt: '2026-06-21', sourceKey: 'money-org' }));
      const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, title: 'Synthetic package', status: 'agreed', sourceKey: 'money-deal' }));
      const at = (today: string) => handler({ httpMethod: 'GET', path: `/api/sponsor-crm/deals/${deal.id}`, headers: {}, queryStringParameters: { today }, body: null }, {}).then(data);
      assert.equal((await at('2026-07-01')).money, 'none');
      const financeItem = {
        PK: `SPONSOR_FINANCE#${deal.id}`, SK: `SPONSOR_FINANCE#${deal.id}`, id: deal.id, recordType: 'sponsor-finance',
        dealId: deal.id, version: 3, invoiceRequirement: 'required', amountDue: '1500', currency: 'EUR', taxMode: 'included',
        invoiceNumber: 'SYN-1', issuedOn: '2026-05-01', dueOn: '2026-06-01', paymentLinkIds: [], recordedPaymentIds: [],
        actorId: 'admin-1', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
      };
      await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: financeItem }));
      let fetched = await at('2026-07-01');
      assert.equal(fetched.money, 'overdue');
      assert.equal(fetched.title, 'Synthetic package');
      assert.equal(fetched.finance.invoiceNumber, 'SYN-1');
      assert.deepEqual(fetched.finance.followUp, { code: 'chase-payment', party: 'us', since: '2026-06-01', daysOverdue: 30 });
      assert.equal((await at('2026-05-15')).money, 'invoiced');
      const paymentKey = `SPONSOR_FINANCE_PAYMENT#${deal.id}#${'a'.repeat(32)}`;
      await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: {
        PK: paymentKey, SK: paymentKey, id: paymentKey, recordType: 'sponsor-finance-payment', dealId: deal.id,
        paymentId: 'a'.repeat(32), receivedOn: '2026-06-20', amount: '1500', currency: 'EUR', method: 'bank-report',
        actorId: 'admin-1', financeVersion: 4, createdAt: '2026-06-20T00:00:00.000Z',
      } }));
      await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: { ...financeItem, version: 4, recordedPaymentIds: [paymentKey] } }));
      fetched = await at('2026-07-01');
      assert.equal(fetched.money, 'paid');
      assert.equal(fetched.finance.lastPaymentOn, '2026-06-20');
      assert.equal(fetched.finance.outstanding, '0');
      await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'webinar', publishedAt: '2026-05-01T00:00:00Z', plannedPublicationDate: '2026-05-01', sourceKey: 'money-slot' });
      fetched = await at('2026-07-01');
      assert.equal(fetched.fulfillment, 'delivered');
      const org = data(await invoke('GET', `/api/sponsor-crm/organizations/${organization.id}?today=2026-07-01`));
      assert.equal(org.relationship, 'customer');
      assert.equal((await invoke('POST', '/api/sponsor-crm/invoices', { dealId: deal.id, amountEur: 1 })).statusCode, 404);
    } finally {
      if (previous === undefined) delete process.env.SPONSOR_FINANCE_ENABLED;
      else process.env.SPONSOR_FINANCE_ENABLED = previous;
    }
  });

  it('atomically prevents duplicate active schedule links and exposes safe summaries', async () => {
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Link Sponsor', notes: 'private org note', sourceKey: 'link-org' }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, status: 'open', sourceKey: 'link-deal' }));
    const first = data(await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'standalone', sourceKey: 'link-one' }));
    const second = data(await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'standalone', sourceKey: 'link-two' }));
    const linked = await invoke('PUT', `/api/sponsor-crm/deliverables/${first.id}/schedule-link`, { version: first.version, scheduleEntryId: 'newsletter-slot-1' });
    assert.equal(linked.statusCode, 200, linked.body);
    assert.equal(Object.hasOwn(data(linked), 'notes'), false);
    const conflict = await invoke('PUT', `/api/sponsor-crm/deliverables/${second.id}/schedule-link`, { version: second.version, scheduleEntryId: 'newsletter-slot-1' });
    assert.equal(conflict.statusCode, 409);
  });

  it('evaluates deterministic alerts and resolves cleared conditions', async () => {
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Alert Sponsor', sourceKey: 'alert-org' }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, status: 'agreed', sourceKey: 'alert-deal' }));
    const slot = data(await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'secondary', plannedPublicationDate: '2026-07-15', materialDeadline: '2026-07-04', sourceKey: 'alert-slot' }));
    const first = await evaluateSponsorBookingAlerts(client, '2026-07-05');
    const second = await evaluateSponsorBookingAlerts(client, '2026-07-05');
    assert.ok(first.created.length >= 1);
    assert.equal(second.created.length, 0);
    const notifications = await listAllNotifications(client);
    assert.ok(notifications.some((n) => (n.metadata as any)?.sponsorDeliverableId === slot.id));
    const updated = data(await invoke('PUT', `/api/sponsor-crm/deliverables/${slot.id}`, { version: slot.version, artifactUrls: ['https://example.invalid/material.pdf'] }));
    assert.equal(updated.artifactUrls.length, 1);
    const resolved = await evaluateSponsorBookingAlerts(client, '2026-07-05');
    assert.ok(resolved.resolved >= 1);
  });

  it('rejects invalid references, dates, enums and unsafe artifact URLs', async () => {
    assert.equal((await invoke('POST', '/api/sponsor-crm/deals', { organizationId: 'missing', status: 'bad' })).statusCode, 400);
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Validation Sponsor', sourceKey: 'validation-org' }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, status: 'open', sourceKey: 'validation-deal' }));
    assert.equal((await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'main', plannedPublicationDate: '2026-02-30' })).statusCode, 400);
    assert.equal((await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'main', artifactUrls: ['http://unsafe.invalid'] })).statusCode, 400);
  });

  it('rolls back conflicting create claims and serializes primary contacts', async () => {
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Concurrency Sponsor', sourceKey: 'concurrency-org' }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, status: 'open', sourceKey: 'concurrency-deal' }));
    assert.equal((await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'main', scheduleEntryId: 'exclusive-slot', sourceKey: 'claim-first' })).statusCode, 201);
    const conflict = await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'secondary', scheduleEntryId: 'exclusive-slot', sourceKey: 'claim-loser' });
    assert.equal(conflict.statusCode, 409, conflict.body);
    const loser = deterministicCrmId('deliverable', 'claim-loser');
    assert.equal((await invoke('GET', `/api/sponsor-crm/deliverables/${loser}`)).statusCode, 404);
    const attempts = await Promise.all([
      invoke('POST', '/api/sponsor-crm/contacts', { organizationId: organization.id, name: 'Primary One', emails: ['one@example.invalid'], primary: true, sourceKey: 'primary-one' }),
      invoke('POST', '/api/sponsor-crm/contacts', { organizationId: organization.id, name: 'Primary Two', emails: ['two@example.invalid'], primary: true, sourceKey: 'primary-two' }),
    ]);
    assert.deepEqual(attempts.map((item) => item.statusCode).sort(), [201, 409]);
  });

  it('revalidates updates and rejects malformed filters and cursors', async () => {
    const first = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Reference One', sourceKey: 'ref-one' }));
    const second = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Reference Two', sourceKey: 'ref-two' }));
    const contact = data(await invoke('POST', '/api/sponsor-crm/contacts', { organizationId: first.id, name: 'Owned Contact', emails: ['owned@example.invalid'], sourceKey: 'owned-contact' }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: first.id, primaryContactId: contact.id, status: 'open', sourceKey: 'owned-deal' }));
    assert.equal((await invoke('PUT', `/api/sponsor-crm/deals/${deal.id}`, { version: deal.version, organizationId: second.id })).statusCode, 422);
    assert.equal((await invoke('PUT', `/api/sponsor-crm/contacts/${contact.id}`, { version: contact.version, organizationId: 'missing' })).statusCode, 422);
    for (const query of [{ cursor: '-1' }, { cursor: 'nope' }, { limit: '101' }, { status: 'bogus' }, { from: '2026-02-30' }, { from: '2026-09-01', to: '2026-08-01' }]) {
      const response = await handler({ httpMethod: 'GET', path: '/api/sponsor-crm/deals', headers: {}, queryStringParameters: query, body: null }, {});
      assert.equal(response.statusCode, 400, JSON.stringify(query));
    }
  });

  it('provides authenticated safe newsletter lookup, attach and detach', async () => {
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Contract Sponsor', notes: 'private org note', sourceKey: 'contract-org' }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, status: 'open', sourceKey: 'contract-deal' }));
    const slot = data(await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'standalone', notes: 'private booking note', artifactUrls: ['https://example.invalid/private.pdf'], sourceKey: 'contract-slot' }));
    process.env.SKIP_AUTH = 'false';
    assert.equal((await invoke('GET', `/api/sponsor-crm/integrations/newsletter/deliverables/${slot.id}`)).statusCode, 401);
    const session = await createSession(client, 'newsletter-scheduler'), auth = { authorization: `Bearer ${session.token}` };
    const lookup = await invoke('GET', `/api/sponsor-crm/integrations/newsletter/deliverables/${slot.id}`, undefined, auth);
    assert.equal(lookup.statusCode, 200);
    assert.equal(lookup.body.includes('private booking note'), false);
    assert.equal(lookup.body.includes('private.pdf'), false);
    const attached = data(await invoke('PUT', `/api/sponsor-crm/deliverables/${slot.id}/schedule-link`, { version: slot.version, scheduleEntryId: 'newsletter-contract-slot' }, auth));
    assert.equal(attached.scheduleEntryId, 'newsletter-contract-slot');
    const detached = data(await invoke('DELETE', `/api/sponsor-crm/deliverables/${slot.id}/schedule-link`, { version: attached.version }, auth));
    assert.equal(detached.scheduleEntryId, undefined);
    process.env.SKIP_AUTH = 'true';
  });

  it('covers every alert rule and recreates an occurrence after resolution', async () => {
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Rule Sponsor', sourceKey: 'rule-org' }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, status: 'agreed', sourceKey: 'rule-deal' }));
    const make = async (sourceKey: string, publication: string, extra: any = {}) => data(await invoke('POST', '/api/sponsor-crm/deliverables', { dealId: deal.id, channel: 'main', plannedPublicationDate: publication, sourceKey, ...extra }));
    const fourteen = await make('rule-14', '2026-07-15');
    const ten = await make('rule-10', '2026-07-11');
    await make('rule-3', '2026-07-04');
    await make('rule-workflow', '2026-08-01', { scheduleEntryId: 'slot-workflow' });
    await make('rule-performance', '2026-06-24', { publishedAt: '2026-06-24', cardId: 'card', requiredLinkUrl: 'https://example.invalid/campaign' });
    await evaluateSponsorBookingAlerts(client, '2026-07-01');
    let notifications = await listAllNotifications(client);
    const codes = new Set(notifications.map((item) => (item.metadata as any)?.sponsorAlertRule));
    for (const code of ['materials-missing-14d', 'materials-missing-10d', 'materials-missing-3d', 'agreed-missing-primary-contact', 'newsletter-workflow-incomplete', 'performance-follow-up-due']) {
      assert.ok(codes.has(code), code);
    }
    const cleared = data(await invoke('PUT', `/api/sponsor-crm/deliverables/${ten.id}`, { version: ten.version, artifactUrls: ['https://example.invalid/material.pdf'] }));
    await evaluateSponsorBookingAlerts(client, '2026-07-01');
    const recurring = data(await invoke('PUT', `/api/sponsor-crm/deliverables/${ten.id}`, { version: cleared.version, artifactUrls: [] }));
    assert.deepEqual(recurring.artifactUrls, []);
    await evaluateSponsorBookingAlerts(client, '2026-07-01');
    notifications = await listAllNotifications(client);
    assert.equal(notifications.filter((item) => (item.metadata as any)?.sponsorDeliverableId === ten.id && (item.metadata as any)?.sponsorAlertRule === 'materials-missing-10d').length, 2);
    assert.ok(fourteen);
  });

  it('imports a sanitized snapshot of companies, deals, deliverables and mail activity', async () => {
    const result = await invoke('POST', '/api/sponsor-crm/imports', IMPORT_FIXTURE);
    assert.equal(result.statusCode, 200, result.body);
    const body = data(result);
    assert.ok(body.companies >= 2);
    assert.ok(body.deals >= 2);
    const deals = data(await handler({ httpMethod: 'GET', path: '/api/sponsor-crm/deals', headers: {}, queryStringParameters: { limit: '100', today: '2026-07-01' }, body: null }, {})).items;
    const packaged = deals.find((item: any) => item.title === 'Synthetic newsletter package');
    const verbal = deals.find((item: any) => item.amountEur === 2700);
    assert.ok(packaged, 'package deal missing');
    assert.ok(verbal, 'verbal deal missing');
    assert.equal(packaged.money, 'none', 'money comes only from sponsor finance');
    assert.equal(packaged.deliverables.length, 1);
    assert.equal(packaged.deliverables[0].cardId, 'synthetic-card-1');
    assert.equal(body.activity, 1);
    const orgs = data(await invoke('GET', '/api/sponsor-crm/organizations?limit=100&today=2026-07-01')).items;
    const cashOrg = orgs.find((item: any) => item.domain === 'cash.example.invalid');
    assert.equal(cashOrg.relationship, 'talking');
    const messages = data(await invoke('GET', `/api/sponsor-crm/organizations/${cashOrg.id}/messages`)).items;
    assert.deepEqual(messages.map((item: any) => item.threadId), ['synthetic-thread-1']);
    const replayed = await invoke('POST', '/api/sponsor-crm/imports', IMPORT_FIXTURE);
    assert.equal(replayed.statusCode, 200, replayed.body);
    const replay = data(replayed);
    assert.equal(replay.activity, 0);
  });

  it('imports name-only companies and attaches people by company name', async () => {
    const imported = await invoke('POST', '/api/sponsor-crm/imports', {
      companies: [{ displayName: 'Name Only Co', sourceKey: 'name-only-org' }],
      people: [{
        email: 'pat@name-only.example.invalid',
        name: 'Pat Name',
        organizationDomain: 'Name Only Co',
        sourceKey: 'name-only-person',
      }],
    });
    assert.equal(imported.statusCode, 200, imported.body);
    const body = data(imported);
    assert.equal(body.companies, 1);
    assert.equal(body.people, 1);
    const orgs = data(await invoke('GET', '/api/sponsor-crm/organizations?limit=100')).items
      .filter((item: any) => item.displayName === 'Name Only Co');
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0].domain, undefined);
    const again = await invoke('POST', '/api/sponsor-crm/imports', {
      companies: [{ displayName: 'Name Only Co', sourceKey: 'name-only-org-again' }],
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(data(again).companies, 0);
    assert.ok(data(again).duplicates >= 1);
  });

  it('merges imported companies by domain and people by email when source keys differ', async () => {
    const existingOrg = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: 'Prior Corp',
      domain: 'merge.example.invalid',
      sourceKey: 'merge-org-prior',
    }));
    const existingPerson = data(await invoke('POST', '/api/sponsor-crm/contacts', {
      organizationId: existingOrg.id,
      name: 'Prior Person',
      emails: ['pat@merge.example.invalid'],
      sourceKey: 'merge-person-prior',
    }));
    const imported = await invoke('POST', '/api/sponsor-crm/imports', {
      companies: [{
        domain: 'merge.example.invalid',
        displayName: 'Imported Merge Corp',
        sourceKey: 'merge-org-import',
      }],
      people: [{
        email: 'pat@merge.example.invalid',
        name: 'Imported Pat',
        organizationDomain: 'merge.example.invalid',
        sourceKey: 'merge-person-import',
      }],
    });
    assert.equal(imported.statusCode, 200, imported.body);
    const body = data(imported);
    assert.equal(body.companies, 0);
    assert.equal(body.people, 0);
    assert.ok(body.duplicates >= 2, JSON.stringify(body));
    const orgs = data(await invoke('GET', '/api/sponsor-crm/organizations?limit=100')).items
      .filter((item: any) => item.domain === 'merge.example.invalid');
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0].id, existingOrg.id);
    const people = data(await invoke('GET', '/api/sponsor-crm/contacts?limit=100')).items
      .filter((item: any) => (item.emails || []).includes('pat@merge.example.invalid'));
    assert.equal(people.length, 1);
    assert.equal(people[0].id, existingPerson.id);
  });

  it('files live mail to a known person and keeps archive search off the dump path', async () => {
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Mail Co', domain: 'mail.example.invalid', sourceKey: 'mail-org' }));
    await invoke('POST', '/api/sponsor-crm/contacts', { organizationId: organization.id, name: 'Mail Person', emails: ['pat@mail.example.invalid'], sourceKey: 'mail-person' });
    const filed = await invoke('POST', '/api/sponsor-crm/messages', { personEmail: 'pat@mail.example.invalid', direction: 'inbound', threadId: 'thread-1', snippet: 'We would like to sponsor', sentAt: '2026-07-01T10:00:00Z' });
    assert.equal(filed.statusCode, 201, filed.body);
    const listed = data(await invoke('GET', `/api/sponsor-crm/organizations/${organization.id}/messages`));
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].direction, 'inbound');
    const unknown = await invoke('POST', '/api/sponsor-crm/messages', { personEmail: 'nobody@unknown.example.invalid', direction: 'inbound', threadId: 'thread-2' });
    assert.equal(unknown.statusCode, 422);
  });
});
