import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { getCrmRecord, listCrmRecords } from '../src/db/sponsorCrm';
import { handler } from '../src/handler';
import {
  leadSourceKey,
  normalizeLeadName,
  normalizeLeadUrl,
  resetSponsorLeadIntakeStateForTests,
  usesReservedTestDomain,
} from '../src/routes/sponsorLeads';

const SECRET = 'sponsor-leads-test-secret';

function newsletter(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Example Newsletter',
    sender: 'news@example.test',
    subject: 'Issue 42: gadgets and gizmos',
    receivedAt: '2026-07-12T10:00:00Z',
    ...overrides,
  };
}

function sponsor(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Acme Gadgets',
    url: 'https://acme.example.test/widgets',
    category: 'tool',
    blurb: 'A fictional widget vendor used only for tests.',
    context: 'Sponsored segment near the middle of the issue.',
    ...overrides,
  };
}

function intakeRequest(messageId: string, sponsors: unknown[], news: Record<string, unknown> | undefined = undefined) {
  return {
    httpMethod: 'POST',
    path: '/api/v1/intake/leads',
    headers: { 'x-dataops-intake-secret': SECRET },
    body: JSON.stringify({
      version: '2026-10-10',
      messageId,
      newsletter: news === undefined ? newsletter() : news,
      sponsors,
    }),
  };
}

const review = (method: string, path: string, body?: unknown, query?: Record<string, string>) => handler({
  httpMethod: method,
  path,
  headers: {},
  queryStringParameters: query || null,
  body: body === undefined ? null : JSON.stringify(body),
}, {});

describe('sponsor lead intake and review', () => {
  before(async () => {
    const localPort = await startLocal();
    await createTables(await getClient(localPort));
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET = SECRET;
    process.env.LEADS_INTAKE_RATE_LIMIT = '1000';
  });

  beforeEach(() => {
    resetSponsorLeadIntakeStateForTests();
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET = SECRET;
    process.env.LEADS_INTAKE_RATE_LIMIT = '1000';
  });

  after(async () => {
    await stopLocal();
    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
    delete process.env.LEADS_INTAKE_RATE_LIMIT;
  });

  it('normalizes names and urls for idempotency', () => {
    assert.strictEqual(normalizeLeadName('  Acme   Co. '), 'acme co.');
    assert.strictEqual(normalizeLeadUrl('https://ACME.example.test/widgets/'), 'acme.example.test/widgets');
    assert.strictEqual(normalizeLeadUrl(''), '');
    assert.strictEqual(
      leadSourceKey('msg-1', '  Acme Co ', 'https://acme.example.test/'),
      leadSourceKey('msg-1', 'acme co', 'https://ACME.example.test'),
    );
  });

  it('accepts a batch and stores reviewable leads in the sponsor CRM table', async () => {
    const result = await handler(intakeRequest('newsletter-101', [sponsor(), sponsor({ name: 'Beta Tools', url: 'https://beta.example.test' })]), {});
    assert.strictEqual(result.statusCode, 201);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.status, 'accepted');
    assert.strictEqual(body.leads.length, 2);
    assert.ok(body.leads.every((lead: { outcome: string }) => lead.outcome === 'created'));
    assert.ok(!result.body.includes('news@example.test'));

    const stored = await getCrmRecord(await getClient(), 'lead', body.leads[0].id);
    assert.strictEqual(stored?.status, 'new');
    assert.strictEqual(stored?.sourceType, 'leads-intake');
    assert.strictEqual(stored?.messageId, 'newsletter-101');
    assert.deepStrictEqual(stored?.newsletter, newsletter());
    assert.strictEqual((stored?.sponsor as Record<string, unknown>)?.normalizedName, 'acme gadgets');
    assert.strictEqual((stored?.sponsor as Record<string, unknown>)?.normalizedUrl, 'acme.example.test/widgets');
    assert.strictEqual(stored?.version, 1);
  });

  it('treats exact replays as duplicates and keeps one record per sponsor identity', async () => {
    const event = intakeRequest('newsletter-202', [sponsor({ name: '  Acme Gadgets ' }), sponsor({ name: 'ACME GADGETS', url: 'https://acme.example.test/widgets/' })]);
    // The two descriptors normalize to the same identity, so the batch is rejected.
    assert.strictEqual((await handler(event, {})).statusCode, 400);

    const single = intakeRequest('newsletter-202', [sponsor()]);
    const first = await handler(single, {});
    assert.strictEqual(first.statusCode, 201);
    const replay = await handler(intakeRequest('newsletter-202', [sponsor({ url: 'https://acme.example.test/widgets/' })]), {});
    assert.strictEqual(replay.statusCode, 200);
    assert.strictEqual(JSON.parse(replay.body).status, 'duplicate');
    assert.strictEqual(JSON.parse(replay.body).leads[0].id, JSON.parse(first.body).leads[0].id);
  });

  it('treats a shuffled stored newsletter as the same lead (DynamoDB key order)', async () => {
    // Real DynamoDB does not preserve document key order: a stored
    // newsletter can come back with shuffled keys, which must not read as
    // a conflict on a byte-identical retry (live 409 regression).
    const first = await handler(intakeRequest('newsletter-shuffled-keys', [sponsor()]), {});
    assert.strictEqual(first.statusCode, 201);
    const id = JSON.parse(first.body).leads[0].id;
    const stored = await getCrmRecord(await getClient(), 'lead', id);
    const shuffled = { receivedAt: stored?.newsletter.receivedAt, subject: stored?.newsletter.subject, sender: stored?.newsletter.sender, name: stored?.newsletter.name };
    await (await getClient()).send(new UpdateCommand({
      TableName: TABLE_SPONSOR_CRM,
      Key: { PK: `LEAD#${id}`, SK: `LEAD#${id}` },
      UpdateExpression: 'SET newsletter = :newsletter',
      ExpressionAttributeValues: { ':newsletter': shuffled },
    }));
    const replay = await handler(intakeRequest('newsletter-shuffled-keys', [sponsor()]), {});
    assert.strictEqual(replay.statusCode, 200);
    assert.strictEqual(JSON.parse(replay.body).status, 'duplicate');
  });

  it('stores the category and treats a changed category as a conflict', async () => {
    const first = await handler(intakeRequest('newsletter-310', [sponsor()]), {});
    assert.strictEqual(first.statusCode, 201);
    const stored = await getCrmRecord(await getClient(), 'lead', JSON.parse(first.body).leads[0].id);
    assert.strictEqual((stored?.sponsor as Record<string, unknown>)?.category, 'tool');
    const same = await handler(intakeRequest('newsletter-310', [sponsor()]), {});
    assert.strictEqual(same.statusCode, 200);
    const changed = await handler(intakeRequest('newsletter-310', [sponsor({ category: 'event' })]), {});
    assert.strictEqual(changed.statusCode, 409);
    assert.strictEqual(JSON.parse(changed.body).error.code, 'idempotency-conflict');
  });

  it('rejects the same sponsor identity with different content', async () => {
    const first = await handler(intakeRequest('newsletter-303', [sponsor()]), {});
    assert.strictEqual(first.statusCode, 201);
    const conflict = await handler(intakeRequest('newsletter-303', [sponsor({ blurb: 'Changed blurb for the same sponsor.' })]), {});
    assert.strictEqual(conflict.statusCode, 409);
    assert.strictEqual(JSON.parse(conflict.body).error.code, 'idempotency-conflict');
    assert.deepStrictEqual(JSON.parse(conflict.body).failures, [{ index: 0, code: 'idempotency-conflict' }]);
  });

  it('reports partial failures without losing successful leads', async () => {
    assert.strictEqual((await handler(intakeRequest('newsletter-404', [sponsor({ name: 'Fresh Vendor' })]), {})).statusCode, 201);
    // Same normalized identity with different substantive content conflicts;
    // the genuinely new sponsor in the same batch is still stored.
    const poisoned = intakeRequest('newsletter-404', [sponsor({ name: 'Fresh Vendor', blurb: 'Changed blurb for the same sponsor.' }), sponsor({ name: 'Brand New Vendor' })]);
    const partial = await handler(poisoned, {});
    assert.strictEqual(partial.statusCode, 207);
    assert.strictEqual(JSON.parse(partial.body).status, 'partial-failure');
    assert.deepStrictEqual(JSON.parse(partial.body).failures, [{ index: 0, code: 'idempotency-conflict' }]);
    assert.strictEqual(JSON.parse(partial.body).leads.length, 1);
  });

  it('keeps sponsors from different messages independent', async () => {
    const first = await handler(intakeRequest('newsletter-505-a', [sponsor()]), {});
    const second = await handler(intakeRequest('newsletter-505-b', [sponsor()]), {});
    assert.strictEqual(first.statusCode, 201);
    assert.strictEqual(second.statusCode, 201);
    assert.notStrictEqual(JSON.parse(first.body).leads[0].id, JSON.parse(second.body).leads[0].id);
  });

  it('rejects authentication, schema, and value errors without persisting', async () => {
    const count = async () => JSON.parse((await review('GET', '/api/sponsor-crm/leads', undefined, { limit: '100' })).body).items.length;
    const initial = await count();
    const before = (await handler(intakeRequest('newsletter-601-probe', [sponsor()]), {}));
    assert.strictEqual(before.statusCode, 201);

    const unauthorized = intakeRequest('unauthorized-601', [sponsor()]);
    unauthorized.headers['x-dataops-intake-secret'] = 'wrong';
    const wrongResult = await handler(unauthorized, {});
    assert.strictEqual(wrongResult.statusCode, 401);
    const missing = intakeRequest('missing-601', [sponsor()]);
    missing.headers = {};
    const missingResult = await handler(missing, {});
    assert.strictEqual(missingResult.statusCode, 401);
    const sameLength = intakeRequest('same-length-601', [sponsor()]);
    sameLength.headers['x-dataops-intake-secret'] = 'x'.repeat(SECRET.length);
    assert.strictEqual((await handler(sameLength, {})).statusCode, 401);
    assert.strictEqual(missingResult.body, wrongResult.body);

    const malformed = intakeRequest('malformed-601', [sponsor()]);
    malformed.body = '{';
    assert.strictEqual((await handler(malformed, {})).statusCode, 400);
    const version = intakeRequest('version-601', [sponsor()]);
    version.body = version.body.replace('2026-10-10', 'v2');
    assert.strictEqual((await handler(version, {})).statusCode, 400);
    const unknownTop = intakeRequest('unknown-601', [sponsor()]);
    unknownTop.body = unknownTop.body.replace('"sponsors":[', '"rawEmail":"private","sponsors":[');
    assert.strictEqual((await handler(unknownTop, {})).statusCode, 400);
    assert.strictEqual((await handler(intakeRequest('not-array-601', 'none' as unknown as unknown[]), {})).statusCode, 400);
    assert.strictEqual((await handler(intakeRequest('too-many-601', Array.from({ length: 21 }, (_, index) => sponsor({ name: `Vendor ${index}` }))), {})).statusCode, 400);
    assert.strictEqual((await handler(intakeRequest('unknown-sponsor-601', [{ ...sponsor(), extra: true }]), {})).statusCode, 400);
    assert.strictEqual((await handler(intakeRequest('http-url-601', [sponsor({ url: 'http://unsafe.example.test' })]), {})).statusCode, 400);
    assert.strictEqual((await handler(intakeRequest('cred-url-601', [sponsor({ url: 'https://user:pass@acme.example.test/' })]), {})).statusCode, 400);
    assert.strictEqual((await handler(intakeRequest('bad-time-601', [sponsor()], { ...newsletter(), receivedAt: '2026-02-30T00:00:00Z' }), {})).statusCode, 400);
    assert.strictEqual((await handler(intakeRequest('future-601', [sponsor()], { ...newsletter(), receivedAt: '2099-01-01T00:00:00Z' }), {})).statusCode, 400);
    assert.strictEqual((await handler(intakeRequest('missing-name-601', [sponsor({ name: '   ' })]), {})).statusCode, 400);

    const oversized = intakeRequest('oversized-601', [sponsor({ blurb: 'x'.repeat(70 * 1024) })]);
    assert.strictEqual((await handler(oversized, {})).statusCode, 413);

    const afterCount = await count();
    assert.strictEqual(afterCount, initial + 1);
  });

  it('refuses reserved test domains on a deployed portal so probes cannot write fictional leads', async () => {
    const real = { name: 'Real Weekly', sender: 'news@realweekly.co', subject: 'Issue 1', receivedAt: '2026-07-12T10:00:00Z' };
    assert.strictEqual(usesReservedTestDomain(real, [{ name: 'Vendor', url: 'https://vendor.io/x', category: '', blurb: '', context: '' }]), false);
    assert.strictEqual(usesReservedTestDomain({ ...real, sender: 'e2e@example.test' }, []), true);
    assert.strictEqual(usesReservedTestDomain(real, [{ name: 'Probe', url: 'https://www.example.com/p', category: '', blurb: '', context: '' }]), true);
    assert.strictEqual(usesReservedTestDomain(real, [{ name: 'Probe', url: 'https://probe.invalid/', category: '', blurb: '', context: '' }]), true);

    const saved = { NODE_ENV: process.env.NODE_ENV, IS_LOCAL: process.env.IS_LOCAL };
    process.env.NODE_ENV = 'production';
    delete process.env.IS_LOCAL;
    let result;
    try {
      result = await handler(intakeRequest('e2e-probe-701', [sponsor({ name: 'ZZZ Fictional Probe Co', url: 'https://example.test/e2e-probe' })],
        newsletter({ sender: 'e2e@example.test' })), {});
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.IS_LOCAL === undefined) delete process.env.IS_LOCAL; else process.env.IS_LOCAL = saved.IS_LOCAL;
    }
    assert.strictEqual(result.statusCode, 422, result.body);
    assert.strictEqual(JSON.parse(result.body).error.code, 'reserved-test-domain');
    const listed = JSON.parse((await review('GET', '/api/sponsor-crm/leads', undefined, { status: '', search: 'zzz fictional' })).body);
    assert.strictEqual(listed.items.length, 0, 'the refused probe stored nothing');
  });

  it('returns configuration errors without attempting persistence', async () => {
    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME;
    const result = await handler(intakeRequest('not-configured-601', [sponsor()]), {});
    assert.strictEqual(result.statusCode, 503);
    assert.strictEqual(JSON.parse(result.body).error.code, 'authentication-not-configured');
  });

  it('throttles by credential id with a retry hint', async () => {
    // A dedicated secret isolates this test from the shared rate-limit bucket
    // used by every other test in this file.
    const throttleSecret = `throttle-secret-${Date.now()}`;
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET = throttleSecret;
    const throttled = (messageId: string, name: string) => {
      const event = intakeRequest(messageId, [sponsor({ name })]);
      event.headers['x-dataops-intake-secret'] = throttleSecret;
      return event;
    };
    process.env.LEADS_INTAKE_RATE_LIMIT = '1';
    const one = throttled('rate-one-601', 'Rate Vendor One');
    const two = throttled('rate-two-601', 'Rate Vendor Two');
    assert.strictEqual((await handler(one, {})).statusCode, 201);
    const limited = await handler(two, {});
    assert.strictEqual(limited.statusCode, 429);
    assert.ok(Number(limited.headers?.['Retry-After']) > 0);
  });

  it('keeps responses and audit logs free of intake content', async () => {
    const logs: string[] = [];
    const original = console.info;
    console.info = (...values: unknown[]) => logs.push(values.join(' '));
    try {
      const result = await handler(intakeRequest('private-message-701', [sponsor({ name: 'Private Vendor Name' })]), {});
      const combined = `${result.body}\n${logs.join('\n')}`;
      for (const privateValue of ['private-message-701', 'Private Vendor Name', 'news@example.test', 'acme.example.test', SECRET]) {
        assert.ok(!combined.includes(privateValue));
      }
      assert.ok(logs.some((line) => line.includes('sponsor-lead-intake') && line.includes('credentialId') && line.includes('correlation')));
    } finally { console.info = original; }
  });
  it('lists, filters, paginates, reviews, and transitions lead status', async () => {
    const accepted = await handler(intakeRequest('review-801', [
      sponsor({ name: 'Alpha Vendor', url: 'https://alpha.example.test' }),
      sponsor({ name: 'Beta Vendor', url: 'https://beta.example.test' }),
    ]), {});
    assert.strictEqual(accepted.statusCode, 201);
    const [alpha, beta] = JSON.parse(accepted.body).leads;

    const list = JSON.parse((await review('GET', '/api/sponsor-crm/leads')).body);
    assert.ok(list.items.length >= 2);
    assert.ok(list.items.every((item: Record<string, unknown>) => item.id && item.sponsor && item.newsletter && typeof item.version === 'number'));

    const search = JSON.parse((await review('GET', '/api/sponsor-crm/leads', undefined, { search: 'alpha vendor' })).body);
    assert.strictEqual(search.items.length, 1);
    assert.strictEqual(search.items[0].id, alpha.id);

    const page = JSON.parse((await review('GET', '/api/sponsor-crm/leads', undefined, { limit: '1' })).body);
    assert.strictEqual(page.items.length, 1);
    assert.strictEqual(typeof page.nextCursor, 'string');
    assert.ok(page.newsletters.includes('Example Newsletter'));
    const secondPage = JSON.parse((await review('GET', '/api/sponsor-crm/leads', undefined, { limit: '1', cursor: page.nextCursor })).body);
    assert.strictEqual(secondPage.items.length, 1);
    assert.notStrictEqual(secondPage.items[0].id, page.items[0].id);
    assert.strictEqual((await review('GET', '/api/sponsor-crm/leads', undefined, { cursor: '1' })).statusCode, 400);
    assert.strictEqual((await review('GET', '/api/sponsor-crm/leads', undefined, { group: 'bogus' })).statusCode, 400);

    assert.strictEqual((await review('GET', '/api/sponsor-crm/leads', undefined, { status: 'bogus' })).statusCode, 400);
    assert.strictEqual((await review('GET', '/api/sponsor-crm/leads', undefined, { limit: '101' })).statusCode, 400);

    const one = await review('GET', `/api/sponsor-crm/leads/${alpha.id}`);
    assert.strictEqual(one.statusCode, 200);
    assert.strictEqual(JSON.parse(one.body).status, 'new');
    assert.strictEqual((await review('GET', '/api/sponsor-crm/leads/missing')).statusCode, 404);

    const transition = await review('PATCH', `/api/sponsor-crm/leads/${alpha.id}`, { version: 1, status: 'triaged' });
    assert.strictEqual(transition.statusCode, 200);
    assert.strictEqual(JSON.parse(transition.body).status, 'triaged');
    assert.strictEqual(JSON.parse(transition.body).version, 2);

    const stale = await review('PATCH', `/api/sponsor-crm/leads/${alpha.id}`, { version: 1, status: 'converted' });
    assert.strictEqual(stale.statusCode, 409);
    const invalid = await review('PATCH', `/api/sponsor-crm/leads/${beta.id}`, { version: 1, status: 'bogus' });
    assert.strictEqual(invalid.statusCode, 400);
    const unknownField = await review('PATCH', `/api/sponsor-crm/leads/${beta.id}`, { version: 1, status: 'ignored', notes: 'x' });
    assert.strictEqual(unknownField.statusCode, 400);

    const badReason = await review('PATCH', `/api/sponsor-crm/leads/${beta.id}`, { version: 1, status: 'ignored', statusReason: 'x'.repeat(501) });
    assert.strictEqual(badReason.statusCode, 400);
    const ignored = await review('PATCH', `/api/sponsor-crm/leads/${beta.id}`, { version: 1, status: 'ignored', statusReason: '  House ad, not a sponsor ' });
    assert.strictEqual(ignored.statusCode, 200, ignored.body);
    assert.strictEqual(JSON.parse(ignored.body).statusReason, 'House ad, not a sponsor');
    const ignoredRow = JSON.parse((await review('GET', '/api/sponsor-crm/leads', undefined, { status: 'ignored' })).body)
      .items.find((item: Record<string, unknown>) => item.id === beta.id);
    assert.strictEqual(ignoredRow.statusReason, 'House ad, not a sponsor');
    const reopened = await review('PATCH', `/api/sponsor-crm/leads/${beta.id}`, { version: 2, status: 'new' });
    assert.strictEqual(reopened.statusCode, 200, reopened.body);
    assert.strictEqual(JSON.parse(reopened.body).statusReason, undefined, 'a status change without a reason clears it');
    const convertReason = await review('PATCH', `/api/sponsor-crm/leads/${beta.id}`, { version: 3, status: 'converted', statusReason: 'x' });
    assert.strictEqual(convertReason.statusCode, 400);

    const filtered = JSON.parse((await review('GET', '/api/sponsor-crm/leads', undefined, { status: 'triaged' })).body);
    assert.ok(filtered.items.some((item: Record<string, unknown>) => item.id === alpha.id));
    assert.ok(!filtered.items.some((item: Record<string, unknown>) => item.id === beta.id));
  });

  it('converts a lead onto an existing company by registrable domain and does not send mail', async () => {
    process.env.SKIP_AUTH = 'true';
    const domain = 'linked-convert.example.invalid';
    const orgResponse = await review('POST', '/api/sponsor-crm/organizations', {
      displayName: 'Linked Convert Co',
      domain,
      sourceKey: 'convert-linked-org',
    });
    assert.strictEqual(orgResponse.statusCode, 201, orgResponse.body);
    const org = JSON.parse(orgResponse.body);
    const accepted = await handler(intakeRequest('convert-domain-901', [
      sponsor({ name: 'Linked Convert Co', url: `https://${domain}/about` }),
    ]), {});
    assert.strictEqual(accepted.statusCode, 201);
    const leadId = JSON.parse(accepted.body).leads[0].id;
    const lead = JSON.parse((await review('GET', `/api/sponsor-crm/leads/${leadId}`)).body);
    const converted = await review('PATCH', `/api/sponsor-crm/leads/${leadId}`, { version: lead.version, status: 'converted' });
    assert.strictEqual(converted.statusCode, 200, converted.body);
    const body = JSON.parse(converted.body);
    assert.strictEqual(body.status, 'converted');
    assert.strictEqual(body.organizationId, org.id);
    assert.strictEqual(body.created, false);
    assert.strictEqual(body.organization.domain, domain);
    assert.ok(Array.isArray(body.organization.sightings));
    assert.strictEqual(body.organization.sightings[0].leadId, leadId);
    const messages = JSON.parse((await review('GET', `/api/sponsor-crm/organizations/${org.id}/messages`)).body);
    assert.deepStrictEqual(messages.items, []);
  });

  it('creates a company when converting a domain that is not yet in the CRM', async () => {
    process.env.SKIP_AUTH = 'true';
    const domain = 'fresh-convert.example.invalid';
    const accepted = await handler(intakeRequest('convert-domain-902', [
      sponsor({ name: 'Fresh Convert Co', url: `https://www.${domain}/` }),
    ]), {});
    assert.strictEqual(accepted.statusCode, 201);
    const leadId = JSON.parse(accepted.body).leads[0].id;
    const lead = JSON.parse((await review('GET', `/api/sponsor-crm/leads/${leadId}`)).body);
    const converted = await review('PATCH', `/api/sponsor-crm/leads/${leadId}`, { version: lead.version, status: 'converted' });
    assert.strictEqual(converted.statusCode, 200, converted.body);
    const body = JSON.parse(converted.body);
    assert.strictEqual(body.created, true);
    assert.strictEqual(body.organization.domain, domain);
    assert.strictEqual(body.status, 'converted');
  });

  it('requires an explicit pick or createNew when converting a name-only lead', async () => {
    process.env.SKIP_AUTH = 'true';
    const orgResponse = await review('POST', '/api/sponsor-crm/organizations', {
      displayName: 'Picker Co',
      sourceKey: 'convert-picker-org',
    });
    assert.strictEqual(orgResponse.statusCode, 201, orgResponse.body);
    const org = JSON.parse(orgResponse.body);
    const accepted = await handler(intakeRequest('convert-name-903', [
      sponsor({ name: 'Picker Co', url: '' }),
      sponsor({ name: 'Brand New Picker Co', url: '' }),
    ]), {});
    assert.strictEqual(accepted.statusCode, 201);
    const [named, fresh] = JSON.parse(accepted.body).leads;
    const namedLead = JSON.parse((await review('GET', `/api/sponsor-crm/leads/${named.id}`)).body);
    const picker = await review('PATCH', `/api/sponsor-crm/leads/${named.id}`, { version: namedLead.version, status: 'converted' });
    assert.strictEqual(picker.statusCode, 409, picker.body);
    const pickerBody = JSON.parse(picker.body);
    assert.strictEqual(pickerBody.error, 'organization-picker-required');
    assert.ok(pickerBody.candidates.some((item: { id: string }) => item.id === org.id));
    assert.strictEqual(JSON.parse((await review('GET', `/api/sponsor-crm/leads/${named.id}`)).body).status, 'new');

    const linked = await review('PATCH', `/api/sponsor-crm/leads/${named.id}`, {
      version: namedLead.version,
      status: 'converted',
      organizationId: org.id,
    });
    assert.strictEqual(linked.statusCode, 200, linked.body);
    assert.strictEqual(JSON.parse(linked.body).organizationId, org.id);
    assert.strictEqual(JSON.parse(linked.body).created, false);

    const freshLead = JSON.parse((await review('GET', `/api/sponsor-crm/leads/${fresh.id}`)).body);
    const created = await review('PATCH', `/api/sponsor-crm/leads/${fresh.id}`, {
      version: freshLead.version,
      status: 'converted',
      createNew: true,
    });
    assert.strictEqual(created.statusCode, 200, created.body);
    const createdBody = JSON.parse(created.body);
    assert.strictEqual(createdBody.created, true);
    assert.notStrictEqual(createdBody.organizationId, org.id);
    const messages = JSON.parse((await review('GET', `/api/sponsor-crm/organizations/${createdBody.organizationId}/messages`)).body);
    assert.deepStrictEqual(messages.items, []);
  });

  it('records every inbox issue on its newsletter, including issues without sponsors', async () => {
    const created = await review('POST', '/api/sponsor-crm/newsletters', {
      name: 'Issue Tracker Weekly',
      url: 'https://tracker.example.test',
      senders: ['tracker@example.test'],
      expectedIntervalDays: 7,
      subscriptionStatus: 'subscribed',
    });
    assert.strictEqual(created.statusCode, 201, created.body);
    const newsletterId = JSON.parse(created.body).id;
    const tracker = (overrides: Record<string, unknown>) => newsletter({ name: 'Issue Tracker Weekly', sender: 'tracker@example.test', ...overrides });

    const none = await handler(intakeRequest('<tracker-1@example.test>', [], tracker({ subject: 'Tracker #1', receivedAt: '2026-10-01T08:00:00Z' })), {});
    assert.strictEqual(none.statusCode, 201, none.body);
    assert.deepStrictEqual(JSON.parse(none.body).leads, []);
    const replay = await handler(intakeRequest('<tracker-1@example.test>', [], tracker({ subject: 'Tracker #1', receivedAt: '2026-10-01T08:00:00Z' })), {});
    assert.strictEqual(replay.statusCode, 200, replay.body);
    assert.strictEqual(JSON.parse(replay.body).status, 'duplicate');

    // Matched by name when the sender is new; the sender is learned.
    const sponsored = await handler(intakeRequest('<tracker-2@example.test>', [sponsor({ name: 'Tracker Sponsor' })],
      tracker({ sender: 'digest@tracker.example.test', subject: 'Tracker #2', receivedAt: '2026-10-08T08:00:00Z' })), {});
    assert.strictEqual(sponsored.statusCode, 201, sponsored.body);
    // An older issue arriving late does not become the latest receipt.
    await handler(intakeRequest('<tracker-0@example.test>', [], tracker({ subject: 'Tracker #0', receivedAt: '2026-09-24T08:00:00Z' })), {});

    const record = JSON.parse((await review('GET', `/api/sponsor-crm/newsletters/${newsletterId}`)).body);
    assert.strictEqual(record.lastSubject, 'Tracker #2');
    assert.strictEqual(record.lastMessageId, '<tracker-2@example.test>');
    assert.deepStrictEqual(record.senders, ['tracker@example.test', 'digest@tracker.example.test']);
    assert.strictEqual(record.issues.issueCount, 3);
    assert.strictEqual(record.issues.issuesWithoutSponsors, 2);

    const issues = JSON.parse((await review('GET', `/api/sponsor-crm/newsletters/${newsletterId}/issues`)).body).items;
    assert.deepStrictEqual(issues.map((item: any) => [item.title, item.source, item.sponsors.map((entry: any) => entry.name)]), [
      ['Tracker #2', 'inbox', ['Tracker Sponsor']],
      ['Tracker #1', 'inbox', []],
      ['Tracker #0', 'inbox', []],
    ]);
  });

  it('creates an outbound lead through the review API and never creates a deal', async () => {
    process.env.SKIP_AUTH = 'true';
    const orgResponse = await review('POST', '/api/sponsor-crm/organizations', { displayName: 'Outbound Target Co', sourceKey: 'outbound-target-org' });
    assert.strictEqual(orgResponse.statusCode, 201, orgResponse.body);
    const org = JSON.parse(orgResponse.body);
    const payload = {
      organizationId: org.id,
      source: 'newsletter',
      url: 'https://outbound-target.example.test/',
      summary: 'Runs sponsored segments in a peer newsletter.',
      observedAt: '2026-10-20T09:30:00Z',
    };
    const created = await review('POST', '/api/sponsor-crm/leads', payload);
    assert.strictEqual(created.statusCode, 201, created.body);
    const lead = JSON.parse(created.body);
    assert.strictEqual(lead.status, 'new');
    assert.strictEqual(lead.source, 'newsletter');
    assert.strictEqual(lead.observedAt, payload.observedAt);
    assert.strictEqual(lead.organizationId, org.id);
    assert.strictEqual(lead.sponsor.url, 'https://outbound-target.example.test/');
    assert.strictEqual(lead.sponsor.normalizedUrl, 'outbound-target.example.test');
    assert.strictEqual(lead.sponsor.name, 'outbound-target.example.test');
    assert.strictEqual(lead.sponsor.blurb, payload.summary);
    assert.strictEqual(lead.sourceType, 'portal');
    assert.strictEqual(lead.newsletter, undefined);
    assert.strictEqual(lead.messageId, undefined);

    // An identical re-file is the same lead, not a second record.
    const replay = await review('POST', '/api/sponsor-crm/leads', payload);
    assert.strictEqual(replay.statusCode, 200, replay.body);
    assert.strictEqual(JSON.parse(replay.body).id, lead.id);

    const listed = JSON.parse((await review('GET', '/api/sponsor-crm/leads', undefined, { search: 'outbound-target.example.test' })).body);
    assert.ok(listed.items.some((item: Record<string, unknown>) => item.id === lead.id));
    const stored = await getCrmRecord(await getClient(), 'lead', lead.id);
    assert.strictEqual(stored?.sourceType, 'portal');

    const deals = await listCrmRecords(await getClient(), 'deal');
    assert.ok(!deals.some((deal) => deal.organizationId === org.id), 'lead create must not create a tracking deal');
  });

  it('rejects invalid outbound lead payloads without persisting', async () => {
    process.env.SKIP_AUTH = 'true';
    const base = { source: 'social', url: 'https://social.example.test/', summary: 'Seen promoting peer events.', observedAt: '2026-10-21T08:00:00Z' };
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['unsupported source', { ...base, source: 'podcast' }],
      ['missing source', { ...base, source: undefined }],
      ['non-https url', { ...base, url: 'http://social.example.test/' }],
      ['missing url', { ...base, url: '' }],
      ['missing summary', { ...base, summary: '' }],
      ['date-only observedAt', { ...base, observedAt: '2026-10-21' }],
      ['future observedAt', { ...base, observedAt: '2099-01-01T00:00:00Z' }],
      ['unknown field', { ...base, dealId: 'should-not-exist' }],
    ];
    for (const [label, payload] of invalid) {
      const result = await review('POST', '/api/sponsor-crm/leads', payload);
      assert.strictEqual(result.statusCode, 400, `${label}: ${result.body}`);
    }
    const unlinked = await review('POST', '/api/sponsor-crm/leads', { ...base, organizationId: 'no-such-organization' });
    assert.strictEqual(unlinked.statusCode, 422, unlinked.body);
  });
});
