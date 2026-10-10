import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { getCrmRecord } from '../src/db/sponsorCrm';
import { handler } from '../src/handler';
import {
  leadSourceKey,
  normalizeLeadName,
  normalizeLeadUrl,
  resetSponsorLeadIntakeStateForTests,
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
    assert.strictEqual((await handler(intakeRequest('empty-601', []), {})).statusCode, 400);
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
    assert.strictEqual(page.nextCursor, '1');
    const secondPage = JSON.parse((await review('GET', '/api/sponsor-crm/leads', undefined, { limit: '1', cursor: '1' })).body);
    assert.strictEqual(secondPage.items.length, 1);

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
});
