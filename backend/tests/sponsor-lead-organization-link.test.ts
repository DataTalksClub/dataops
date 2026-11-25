import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createOrganizationAtomic, getCrmRecord, listCrmRecords, updateCrmRecord } from '../src/db/sponsorCrm';
import { handler } from '../src/handler';
import { matchLeadOrganization } from '../src/sponsorCrm/leadOrganizationLink';
import { resetSponsorLeadIntakeStateForTests } from '../src/routes/sponsorLeads';

const SECRET = 'lead-link-test-secret';
const NEWSLETTER = { name: 'Example Digest', sender: 'digest@publisher.example.test', subject: 'Issue 7', receivedAt: '2026-11-12T10:00:00Z' };

const intake = (messageId: string, sponsors: Array<Record<string, string>>) => handler({
  httpMethod: 'POST',
  path: '/api/v1/intake/leads',
  headers: { 'x-dataops-intake-secret': SECRET },
  body: JSON.stringify({ version: '2026-10-10', messageId, newsletter: NEWSLETTER, sponsors: sponsors.map((item) => ({ category: 'tool', blurb: 'Synthetic blurb', context: 'Synthetic context', ...item })) }),
}, {});

const link = (body?: unknown) => handler({ httpMethod: 'POST', path: '/api/sponsor-crm/leads/link-organizations', headers: {}, body: body === undefined ? null : JSON.stringify(body) }, {});

describe('sponsor lead company linking', () => {
  before(async () => {
    const port = await startLocal();
    await createTables(await getClient(port));
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

  it('links at intake by domain and by exact name, leaving unclear sponsors unlinked', async () => {
    const client = await getClient();
    const byDomain = (await createOrganizationAtomic(client, { displayName: 'Orbit Data', domain: 'orbitdata.example.test' }, 't')).item;
    const byName = (await createOrganizationAtomic(client, { displayName: 'Nimbus Systems' }, 't')).item;
    await createOrganizationAtomic(client, { displayName: 'Nimbus Cloud', domain: 'nimbus-cloud.example.test' }, 't');

    const result = await intake('link-1', [
      { name: 'Orbit Data Inc', url: 'https://www.orbitdata.example.test/promo?utm_source=x' },
      { name: '  nimbus   SYSTEMS ', url: 'https://track.mailer.example.test/c/abc' },
      { name: 'Nimbus Systems Pro', url: 'https://pro.nimbus-systems.example.test' },
    ]);
    assert.strictEqual(result.statusCode, 201, result.body);
    const leads = JSON.parse(result.body).leads;
    assert.strictEqual(leads[0].organizationId, byDomain.id);
    assert.strictEqual(leads[1].organizationId, byName.id);
    assert.strictEqual(leads[2].organizationId, undefined);

    const stored = await getCrmRecord(client, 'lead', leads[0].id);
    assert.strictEqual(stored?.organizationId, byDomain.id);
    assert.strictEqual(stored?.status, 'new');
    assert.strictEqual((stored?.sponsor as Record<string, unknown>).name, 'Orbit Data Inc');
    const org = await getCrmRecord(client, 'organization', byDomain.id);
    assert.strictEqual((org?.sightings as unknown[]).length, 1);
    assert.strictEqual((await listCrmRecords(client, 'deal')).length, 0);
  });

  it("does not match on the publisher domain, duplicate names, conflicting evidence or somebody else's platform", () => {
    const org = (id: string, displayName: string, domain?: string) => ({ id, displayName, ...(domain ? { domain } : {}), version: 1 }) as never;
    const lead = (name: string, url: string) => ({ id: 'l', newsletter: NEWSLETTER, sponsor: { name, url } }) as never;
    const orgs = [org('a', 'Twin'), org('b', 'Twin'), org('c', 'Publisher', 'publisher.example.test'), org('d', 'Alpha', 'alpha.example.test'), org('e', 'Beta'), org('m', 'Maven', 'maven.com'), org('h', 'Hex Technologies', 'hex.tech'), { ...org('f', 'Gone', 'gone.example.test'), archivedAt: 'x' } as never];
    assert.strictEqual(matchLeadOrganization(lead('Twin', ''), orgs).kind, 'ambiguous');
    assert.strictEqual(matchLeadOrganization(lead('Something', 'https://publisher.example.test/x'), orgs).kind, 'none');
    assert.strictEqual(matchLeadOrganization(lead('Beta', 'https://alpha.example.test'), orgs).kind, 'ambiguous');
    assert.strictEqual(matchLeadOrganization(lead('Gone', 'https://gone.example.test'), orgs).kind, 'none');
    assert.strictEqual(matchLeadOrganization(lead('Alpha', 'https://alpha.example.test'), orgs).kind, 'linked');
    // A link hosted on a platform is not that platform's sponsorship: the
    // sponsor's name still has to read as the domain's company.
    assert.strictEqual(matchLeadOrganization(lead('Applied LLMs', 'https://maven.com/courses/applied-llms'), orgs).kind, 'none');
    assert.strictEqual(matchLeadOrganization(lead('', 'https://hex.tech'), orgs).kind, 'none');
    const hex = matchLeadOrganization(lead('Hex', 'https://hex.tech'), orgs);
    assert.ok(hex.kind === 'linked' && hex.by === 'domain');
    assert.ok(matchLeadOrganization(lead('AWS re:Invent', 'https://aws.amazon.com/'), [org('aws', 'AWS', 'aws.amazon.com')]).kind === 'linked');
  });

  it('reconciles existing unlinked leads: dry run first, then apply, idempotent, preserving linked ones', async () => {
    const client = await getClient();
    const first = JSON.parse((await intake('link-2', [
      { name: 'Quasar Labs', url: 'https://quasar.example.test' },
      { name: 'Pulsar', url: 'https://pulsar.example.test' },
      { name: 'Quasar Product', url: 'https://quasar-product.example.test' },
    ])).body).leads;
    // A lead somebody dismissed keeps its company untouched even once the company exists.
    const dismissed = JSON.parse((await intake('link-3', [{ name: 'Quasar Labs', url: 'https://quasar.example.test/webinar' }])).body).leads[0];
    await updateCrmRecord(client, 'lead', (await getCrmRecord(client, 'lead', dismissed.id))!, { status: 'ignored', statusReason: 'house ad' });
    const quasar = (await createOrganizationAtomic(client, { displayName: 'Quasar Labs', domain: 'quasar.example.test' }, 't')).item;
    const pulsarA = (await createOrganizationAtomic(client, { displayName: 'Pulsar' }, 't')).item;
    await createOrganizationAtomic(client, { displayName: 'pulsar' }, 't');

    const preview = JSON.parse((await link()).body);
    assert.strictEqual(preview.dryRun, true);
    assert.ok(preview.linked >= 1 && preview.ambiguous >= 1);
    assert.strictEqual(preview.dismissed, 1);
    assert.strictEqual((await getCrmRecord(client, 'lead', first[0].id))?.organizationId, undefined);

    const applied = JSON.parse((await link({ apply: true })).body);
    assert.strictEqual(applied.dryRun, false);
    assert.ok(applied.examples.linked.some((item: { leadId: string; organizationId: string }) => item.leadId === first[0].id && item.organizationId === quasar.id));
    assert.ok(applied.examples.ambiguous.some((item: { leadId: string }) => item.leadId === first[1].id));
    assert.strictEqual((await getCrmRecord(client, 'lead', first[0].id))?.organizationId, quasar.id);
    assert.strictEqual((await getCrmRecord(client, 'lead', first[1].id))?.organizationId, undefined);
    assert.strictEqual((await getCrmRecord(client, 'lead', first[2].id))?.organizationId, undefined);
    assert.notStrictEqual(pulsarA.id, '');
    const linked = await getCrmRecord(client, 'lead', first[0].id);
    assert.strictEqual(linked?.status, 'new');
    assert.deepStrictEqual(linked?.newsletter, NEWSLETTER);

    const again = JSON.parse((await link({ apply: true })).body);
    assert.strictEqual(again.linked, 0);
    assert.strictEqual(again.dismissed, 1);
    assert.strictEqual((await getCrmRecord(client, 'lead', dismissed.id))?.organizationId, undefined);
    assert.strictEqual((await getCrmRecord(client, 'lead', dismissed.id))?.status, 'ignored');
    assert.strictEqual((await getCrmRecord(client, 'organization', quasar.id))?.sightings.length, 1);
    assert.strictEqual((await link({ bogus: 1 })).statusCode, 400);
  });

  it('a re-delivered message keeps a link somebody made and links an older lead once its company exists', async () => {
    const client = await getClient();
    const deliver = (messageId: string, name: string, url: string) => intake(messageId, [{ name, url }]);
    // Delivered before a matching company existed: all three stay unlinked.
    const chosen = JSON.parse((await deliver('link-4', 'Vega Tools', 'https://vega.example.test/offer')).body).leads[0];
    const late = JSON.parse((await deliver('link-5', 'Kite Analytics', 'https://kite.example.test')).body).leads[0];
    const twin = JSON.parse((await deliver('link-6', 'Twin Analytics', 'https://track.mailer.example.test/c/twin')).body).leads[0];
    const houseAd = JSON.parse((await deliver('link-7', 'House Ad', 'https://house-ad.example.test')).body).leads[0];
    await updateCrmRecord(client, 'lead', (await getCrmRecord(client, 'lead', houseAd.id))!, { status: 'ignored', statusReason: 'house ad' });
    for (const lead of [chosen, late, twin, houseAd]) assert.strictEqual(lead.organizationId, undefined);

    const operatorPick = (await createOrganizationAtomic(client, { displayName: 'Vega Partners' }, 't')).item;
    await updateCrmRecord(client, 'lead', (await getCrmRecord(client, 'lead', chosen.id))!, { organizationId: operatorPick.id });
    const obvious = (await createOrganizationAtomic(client, { displayName: 'Vega Tools', domain: 'vega.example.test' }, 't')).item;
    const houseAdCompany = (await createOrganizationAtomic(client, { displayName: 'House Ad', domain: 'house-ad.example.test' }, 't')).item;
    const twins = [
      (await createOrganizationAtomic(client, { displayName: 'Twin Analytics', domain: 'twin-a.example.test' }, 't')).item,
      (await createOrganizationAtomic(client, { displayName: 'twin  analytics', domain: 'twin-b.example.test' }, 't')).item,
    ];

    // Neither the reconcile route nor a retry moves a link somebody already made
    // or touches a dismissed lead, and two same-named companies stay a review
    // item on every path.
    const reconciled = JSON.parse((await link({ apply: true })).body);
    assert.strictEqual(reconciled.linked, 0);
    assert.ok(reconciled.dismissed >= 1);
    const retried = JSON.parse((await deliver('link-4', 'Vega Tools', 'https://vega.example.test/offer')).body).leads[0];
    assert.strictEqual(retried.outcome, 'duplicate');
    assert.strictEqual(retried.organizationId, operatorPick.id);
    assert.strictEqual((await getCrmRecord(client, 'lead', chosen.id))?.organizationId, operatorPick.id);
    assert.deepStrictEqual((await getCrmRecord(client, 'organization', obvious.id))?.sightings ?? [], []);
    assert.strictEqual(JSON.parse((await deliver('link-6', 'Twin Analytics', 'https://track.mailer.example.test/c/twin')).body).leads[0].organizationId, undefined);
    assert.strictEqual((await getCrmRecord(client, 'lead', twin.id))?.organizationId, undefined);
    for (const item of twins) assert.deepStrictEqual((await getCrmRecord(client, 'organization', item.id))?.sightings ?? [], []);
    assert.strictEqual(JSON.parse((await deliver('link-7', 'House Ad', 'https://house-ad.example.test')).body).leads[0].organizationId, undefined);
    assert.strictEqual((await getCrmRecord(client, 'lead', houseAd.id))?.status, 'ignored');
    assert.deepStrictEqual((await getCrmRecord(client, 'organization', houseAdCompany.id))?.sightings ?? [], []);

    // The lead that arrived without its company links on the retry, exactly once.
    const kite = (await createOrganizationAtomic(client, { displayName: 'Kite Analytics', domain: 'kite.example.test' }, 't')).item;
    const linkedDelivery = JSON.parse((await deliver('link-5', 'Kite Analytics', 'https://kite.example.test')).body).leads[0];
    assert.strictEqual(linkedDelivery.outcome, 'duplicate');
    assert.strictEqual(linkedDelivery.organizationId, kite.id);
    assert.strictEqual(JSON.parse((await deliver('link-5', 'Kite Analytics', 'https://kite.example.test')).body).leads[0].organizationId, kite.id);
    const stored = await getCrmRecord(client, 'lead', late.id);
    assert.strictEqual(stored?.organizationId, kite.id);
    assert.strictEqual(stored?.status, 'new');
    assert.strictEqual(stored?.messageId, 'link-5');
    assert.deepStrictEqual(stored?.newsletter, NEWSLETTER);
    const sightings = (await getCrmRecord(client, 'organization', kite.id))?.sightings as Array<{ leadId: string; newsletter: string; url: string }>;
    assert.deepStrictEqual(sightings.map((item) => [item.leadId, item.newsletter, item.url]), [[late.id, NEWSLETTER.name, 'https://kite.example.test']]);
    assert.strictEqual((await listCrmRecords(client, 'deal')).length, 0);
  });
});
